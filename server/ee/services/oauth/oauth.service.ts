import { Injectable, NotAcceptableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OrganizationsService } from '@services/organizations.service';
import { OrganizationUsersService } from '@services/organization_users.service';
import { UsersService } from '@services/users.service';
import { decamelizeKeys } from 'humps';
import { OidcOAuthService } from './oidc_auth.service';
import { Organization } from 'src/entities/organization.entity';
import { OrganizationUser } from 'src/entities/organization_user.entity';
import { SSOConfigs } from 'src/entities/sso_config.entity';
import { User } from 'src/entities/user.entity';
import { dbTransactionWrap, isSuperAdmin } from 'src/helpers/utils.helper';
import { DeepPartial, EntityManager } from 'typeorm';
import { GitOAuthService } from './git_oauth.service';
import { GoogleOAuthService } from './google_oauth.service';
import UserResponse from './models/user_response';
import License from '@ee/licensing/configs/License';
import { InstanceSettingsService } from '@services/instance_settings.service';

@Injectable()
export class OauthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly organizationService: OrganizationsService,
    private readonly jwtService: JwtService,
    private readonly organizationUsersService: OrganizationUsersService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly gitOAuthService: GitOAuthService,
    private readonly oidcOAuthService: OidcOAuthService,
    private readonly instanceSettingsService: InstanceSettingsService,
    private configService: ConfigService
  ) {}

  #isValidDomain(email: string, restrictedDomain: string): boolean {
    if (!email) {
      return false;
    }
    const domain = email.substring(email.lastIndexOf('@') + 1);

    if (!restrictedDomain) {
      return true;
    }
    if (!domain) {
      return false;
    }
    if (
      !restrictedDomain
        .split(',')
        .map((e) => e && e.trim())
        .filter((e) => !!e)
        .includes(domain)
    ) {
      return false;
    }
    return true;
  }

  async #findOrCreateUser(
    { firstName, lastName, email }: UserResponse,
    organization: DeepPartial<Organization>,
    manager?: EntityManager
  ): Promise<User> {
    const existingUser = await this.usersService.findByEmail(email, organization.id, ['active', 'invited']);
    const organizationUser = existingUser?.organizationUsers?.[0];

    if (!organizationUser) {
      // User not exist in the workspace
      const { user, newUserCreated } = await this.usersService.findOrCreateByEmail(
        { firstName, lastName, email },
        organization.id,
        manager
      );

      if (newUserCreated) {
        await this.organizationUsersService.create(user, organization, false, manager);
      }
      return user;
    } else {
      if (organizationUser.status !== 'active') {
        await this.organizationUsersService.activate(organizationUser.id, manager);
      }
      return existingUser;
    }
  }

  async #findAndActivateUser(email: string, organizationId: string, manager?: EntityManager): Promise<User> {
    const user = await this.usersService.findByEmail(email, organizationId, ['active', 'invited']);
    if (!user) {
      throw new UnauthorizedException('User does not exist in the workspace');
    }
    const organizationUser: OrganizationUser = user.organizationUsers?.[0];

    if (!organizationUser) {
      throw new UnauthorizedException('User does not exist in the workspace');
    }
    if (organizationUser.status !== 'active') {
      await this.organizationUsersService.activate(organizationUser.id, manager);
    }
    return user;
  }

  async #generateLoginResultPayload(
    user: User,
    organization: DeepPartial<Organization>,
    isInstanceSSO: boolean
  ): Promise<any> {
    const JWTPayload: JWTPayload = {
      username: user.id,
      sub: user.email,
      organizationId: organization.id,
      isSSOLogin: isInstanceSSO,
    };
    user.organizationId = organization.id;

    return decamelizeKeys({
      id: user.id,
      auth_token: this.jwtService.sign(JWTPayload),
      email: user.email,
      first_name: user.firstName,
      last_name: user.lastName,
      organizationId: organization.id,
      organization: organization.name,
      superAdmin: isSuperAdmin(user),
      admin: await this.usersService.hasGroup(user, 'admin'),
      group_permissions: await this.usersService.groupPermissions(user),
      app_group_permissions: await this.usersService.appGroupPermissions(user),
    });
  }

  #getSSOConfigs(ssoType: 'google' | 'git' | 'openid'): Partial<SSOConfigs> {
    switch (ssoType) {
      case 'google':
        return {
          enabled: !!this.configService.get<string>('SSO_GOOGLE_OAUTH2_CLIENT_ID'),
          configs: { clientId: this.configService.get<string>('SSO_GOOGLE_OAUTH2_CLIENT_ID') },
        };
      case 'git':
        return {
          enabled: !!this.configService.get<string>('SSO_GIT_OAUTH2_CLIENT_ID'),
          configs: {
            clientId: this.configService.get<string>('SSO_GIT_OAUTH2_CLIENT_ID'),
            clientSecret: this.configService.get<string>('SSO_GIT_OAUTH2_CLIENT_SECRET'),
            hostName: this.configService.get<string>('SSO_GIT_OAUTH2_HOST'),
          },
        };
      case 'openid':
        return {
          enabled: !!this.configService.get<string>('SSO_OPENID_CLIENT_ID'),
          configs: {
            clientId: this.configService.get<string>('SSO_OPENID_CLIENT_ID'),
            clientSecret: this.configService.get<string>('SSO_OPENID_CLIENT_SECRET'),
            wellKnownUrl: this.configService.get<string>('SSO_OPENID_WELL_KNOWN_URL'),
          },
        };
      default:
        return;
    }
  }

  #getInstanceSSOConfigs(ssoType: 'google' | 'git' | 'openid'): DeepPartial<SSOConfigs> {
    return {
      organization: {
        enableSignUp: this.configService.get<string>('SSO_DISABLE_SIGNUPS') !== 'true',
        domain: this.configService.get<string>('SSO_ACCEPTED_DOMAINS'),
      },
      sso: ssoType,
      ...this.#getSSOConfigs(ssoType),
    };
  }

  async signIn(
    ssoResponse: SSOResponse,
    configId?: string,
    ssoType?: 'google' | 'git' | 'openid',
    cookies?: object
  ): Promise<any> {
    const { organizationId } = ssoResponse;
    let ssoConfigs: DeepPartial<SSOConfigs>;
    let organization: DeepPartial<Organization>;
    const isSingleOrganization = this.configService.get<string>('DISABLE_MULTI_WORKSPACE') === 'true';

    if (configId) {
      // SSO under an organization
      ssoConfigs = await this.organizationService.getConfigs(configId);
      organization = ssoConfigs?.organization;
    } else if (!isSingleOrganization && ssoType && organizationId) {
      // Instance SSO login from organization login page
      organization = await this.organizationService.fetchOrganizationDetails(organizationId, [true], false, true);
      ssoConfigs = organization?.ssoConfigs?.find((conf) => conf.sso === ssoType);
    } else if (!isSingleOrganization && ssoType) {
      // Instance SSO login from common login page
      ssoConfigs = this.#getInstanceSSOConfigs(ssoType);
      organization = ssoConfigs?.organization;
    } else {
      throw new UnauthorizedException();
    }

    if (!organization || !ssoConfigs) {
      // Should obtain organization configs
      throw new UnauthorizedException();
    }
    const { enableSignUp, domain } = organization;
    const { sso, configs } = ssoConfigs;
    const { token } = ssoResponse;

    let userResponse: UserResponse;
    switch (sso) {
      case 'google':
        userResponse = await this.googleOAuthService.signIn(token, configs);
        break;

      case 'git':
        userResponse = await this.gitOAuthService.signIn(token, configs);
        break;

      case 'openid':
        if (!License.Instance.oidc) {
          throw new UnauthorizedException('OIDC login disabled');
        }
        userResponse = await this.oidcOAuthService.signIn(token, {
          ...configs,
          configId,
          codeVerifier: cookies['oidc_code_verifier'],
        });
        break;

      default:
        break;
    }

    if (!(userResponse.userSSOId && userResponse.email)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    let userDetails: User = await this.usersService.findByEmail(userResponse.email);

    if (userDetails?.status === 'archived') {
      throw new NotAcceptableException('User has been removed from the system, please contact the administrator');
    }

    if (!isSuperAdmin(userDetails) && !this.#isValidDomain(userResponse.email, domain)) {
      throw new UnauthorizedException(`You cannot sign in using the mail id - Domain verification failed`);
    }

    if (!userResponse.firstName) {
      // If firstName not found
      userResponse.firstName = userResponse.email?.split('@')?.[0];
    }

    const allowPersonalWorkspace =
      isSuperAdmin(userDetails) ||
      (await this.instanceSettingsService.getSettings('ALLOW_PERSONAL_WORKSPACE')) === 'true' ||
      (await this.usersService.getCount()) === 0;

    let organizationDetails: DeepPartial<Organization>;
    const isInstanceSSOLogin = !!(!configId && ssoType);

    await dbTransactionWrap(async (manager: EntityManager) => {
      if (!isSingleOrganization && isInstanceSSOLogin && !organizationId) {
        // Login from main login page - Multi-Workspace enabled

        if (!userDetails && enableSignUp && allowPersonalWorkspace) {
          // Create new user
          let defaultOrganization: DeepPartial<Organization> = organization;

          // Not logging in to specific organization, creating new
          defaultOrganization = await this.organizationService.create('Untitled workspace', null, manager);

          const groups = ['all_users', 'admin'];
          userDetails = await this.usersService.create(
            {
              firstName: userResponse.firstName,
              lastName: userResponse.lastName,
              email: userResponse.email,
            },
            defaultOrganization.id,
            groups,
            null,
            null,
            null,
            manager
          );

          await this.organizationUsersService.create(userDetails, defaultOrganization, false, manager);
          organizationDetails = defaultOrganization;
        } else if (!userDetails) {
          throw new UnauthorizedException('User does not exist in the workspace');
        } else if (userDetails.invitationToken) {
          // User account setup not done, activating default organization
          await this.usersService.updateUser(userDetails.id, { invitationToken: null }, manager);
          await this.organizationUsersService.activate(userDetails.defaultOrganizationId, manager);
        }

        if (!organizationDetails) {
          // Finding organization to be loaded
          let organizationList: Organization[];
          if (!isSuperAdmin(userDetails)) {
            organizationList = await this.organizationService.findOrganizationWithLoginSupport(userDetails, 'sso');
          } else {
            const superAdminOrganization = // Default organization or pick any
              (await manager.findOne(Organization, { id: userDetails.defaultOrganizationId })) ||
              (await this.organizationService.getSingleOrganization());

            organizationList = [superAdminOrganization];
          }

          const defaultOrgDetails: Organization = organizationList?.find(
            (og) => og.id === userDetails.defaultOrganizationId
          );
          if (defaultOrgDetails) {
            // default organization SSO login enabled
            organizationDetails = defaultOrgDetails;
          } else if (organizationList?.length > 0) {
            // default organization SSO login not enabled, picking first one from SSO enabled list
            organizationDetails = organizationList[0];
          } else if (allowPersonalWorkspace) {
            // no SSO login enabled organization available for user - creating new one
            organizationDetails = await this.organizationService.create('Untitled workspace', userDetails, manager);
          } else {
            throw new UnauthorizedException('User not included in any workspace');
          }
        }
      } else {
        // Direct login to an organization/single workspace enabled
        userDetails = await (!enableSignUp
          ? this.#findAndActivateUser(userResponse.email, organization.id, manager)
          : this.#findOrCreateUser(userResponse, organization, manager));

        if (!userDetails) {
          throw new UnauthorizedException(`Email id ${userResponse.email} is not registered`);
        }

        organizationDetails = organization;
      }
      await this.usersService.validateLicense(manager);
    });

    return await this.#generateLoginResultPayload(userDetails, organizationDetails, isInstanceSSOLogin);
  }
}

interface SSOResponse {
  token: string;
  state?: string;
  codeVerifier?: string;
  organizationId?: string;
}

interface JWTPayload {
  username: string;
  sub: string;
  organizationId: string;
  isSSOLogin: boolean;
}
