import { type TwitterAuthOptions, TwitterGuestAuth } from './auth';
import { requestApi } from './api';
import { CookieJar } from 'tough-cookie';
import { updateCookieJar } from './requests';
import { Headers } from 'headers-polyfill';
import type { TwitterApiErrorRaw } from './errors';
import { Type, type Static } from '@sinclair/typebox';
import { Check } from '@sinclair/typebox/value';
import * as OTPAuth from 'otpauth';
import { type LegacyUserRaw, parseProfile, type Profile } from './profile';

interface TwitterUserAuthFlowInitRequest {
  flow_name: string;
  input_flow_data: Record<string, unknown>;
}

interface TwitterUserAuthFlowSubtaskRequest {
  flow_token: string;
  subtask_inputs: ({
    subtask_id: string;
  } & Record<string, unknown>)[];
}

type TwitterUserAuthFlowRequest =
  | TwitterUserAuthFlowInitRequest
  | TwitterUserAuthFlowSubtaskRequest;

interface TwitterUserAuthFlowResponse {
  errors?: TwitterApiErrorRaw[];
  flow_token?: string;
  status?: string;
  subtasks?: TwitterUserAuthSubtask[];
}

interface TwitterUserAuthVerifyCredentials {
  errors?: TwitterApiErrorRaw[];
}

const TwitterUserAuthSubtask = Type.Object({
  subtask_id: Type.String(),
  enter_text: Type.Optional(Type.Object({})),
});
type TwitterUserAuthSubtask = Static<typeof TwitterUserAuthSubtask>;

type FlowTokenResultSuccess = {
  status: 'success';
  flowToken: string;
  subtask?: TwitterUserAuthSubtask;
};

type FlowTokenResult = FlowTokenResultSuccess | { status: 'error'; err: Error };

/**
 * A user authentication token manager.
 */
export class TwitterUserAuth extends TwitterGuestAuth {
  private userProfile: Profile | undefined;

  constructor(bearerToken: string, options?: Partial<TwitterAuthOptions>) {
    super(bearerToken, options);
  }

  async isLoggedIn(): Promise<boolean> {
    const res = await requestApi<TwitterUserAuthVerifyCredentials>(
      'https://api.twitter.com/1.1/account/verify_credentials.json',
      this,
    );
    if (!res.success) {
      return false;
    }

    const { value: verify } = res;
    this.userProfile = parseProfile(
      verify as LegacyUserRaw,
      (verify as unknown as { verified: boolean }).verified,
    );
    return verify && !verify.errors?.length;
  }

  async me(): Promise<Profile | undefined> {
    if (this.userProfile) {
      return this.userProfile;
    }
    await this.isLoggedIn();
    return this.userProfile;
  }

  async login(
    username: string,
    password: string,
    email?: string,
    twoFactorSecret?: string,
    appKey?: string,
    appSecret?: string,
    accessToken?: string,
    accessSecret?: string,
  ): Promise<void> {
    await this.updateGuestToken();

    let next = await this.initLogin();
    while ('subtask' in next && next.subtask) {
      if (next.subtask.subtask_id === 'LoginJsInstrumentationSubtask') {
        next = await this.handleJsInstrumentationSubtask(next);
      } else if (next.subtask.subtask_id === 'LoginEnterUserIdentifierSSO') {
        next = await this.handleEnterUserIdentifierSSO(next, username);
      } else if (
        next.subtask.subtask_id === 'LoginEnterAlternateIdentifierSubtask'
      ) {
        next = await this.handleEnterAlternateIdentifierSubtask(
          next,
          email as string,
        );
      } else if (next.subtask.subtask_id === 'LoginEnterPassword') {
        next = await this.handleEnterPassword(next, password);
      } else if (next.subtask.subtask_id === 'AccountDuplicationCheck') {
        next = await this.handleAccountDuplicationCheck(next);
      } else if (next.subtask.subtask_id === 'LoginTwoFactorAuthChallenge') {
        if (twoFactorSecret) {
          next = await this.handleTwoFactorAuthChallenge(next, twoFactorSecret);
        } else {
          throw new Error(
            'Requested two factor authentication code but no secret provided',
          );
        }
      } else if (next.subtask.subtask_id === 'LoginAcid') {
        next = await this.handleAcid(next, email);
      } else if (next.subtask.subtask_id === 'LoginSuccessSubtask') {
        next = await this.handleSuccessSubtask(next);
      } else {
        throw new Error(`Unknown subtask ${next.subtask.subtask_id}`);
      }
    }
    if (appKey && appSecret && accessToken && accessSecret) {
      this.loginWithV2(appKey, appSecret, accessToken, accessSecret);
    }
    if ('err' in next) {
      throw next.err;
    }
  }

  async logout(): Promise<void> {
    if (!this.isLoggedIn()) {
      return;
    }

    await requestApi<void>(
      'https://api.twitter.com/1.1/account/logout.json',
      this,
      'POST',
    );
    this.deleteToken();
    this.jar = new CookieJar();
  }

  async installCsrfToken(headers: Headers): Promise<void> {
    const cookies = await this.getCookies();
    const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');
    if (xCsrfToken) {
      headers.set('x-csrf-token', xCsrfToken.value);
    }
  }

  async installTo(headers: Headers): Promise<void> {
    headers.set('authorization', `Bearer ${this.bearerToken}`);
    headers.set('cookie', await this.getCookieString());
    await this.installCsrfToken(headers);
  }

  private async initLogin() {
    // Reset certain session-related cookies because Twitter complains sometimes if we don't
    this.removeCookie('twitter_ads_id=');
    this.removeCookie('ads_prefs=');
    this.removeCookie('_twitter_sess=');
    this.removeCookie('zipbox_forms_auth_token=');
    this.removeCookie('lang=');
    this.removeCookie('bouncer_reset_cookie=');
    this.removeCookie('twid=');
    this.removeCookie('twitter_ads_idb=');
    this.removeCookie('email_uid=');
    this.removeCookie('external_referer=');
    this.removeCookie('ct0=');
    this.removeCookie('aa_u=');

    return await this.executeFlowTask({
      flow_name: 'login',
      input_flow_data: {
        flow_context: {
          debug_overrides: {},
          start_location: {
            location: 'splash_screen',
          },
        },
      },
    });
  }

  private async handleJsInstrumentationSubtask(prev: FlowTokenResultSuccess) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'LoginJsInstrumentationSubtask',
          js_instrumentation: {
            response: '{}',
            link: 'next_link',
          },
        },
      ],
    });
  }

  private async handleEnterAlternateIdentifierSubtask(
    prev: FlowTokenResultSuccess,
    email: string,
  ) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'LoginEnterAlternateIdentifierSubtask',
          enter_text: {
            text: email,
            link: 'next_link',
          },
        },
      ],
    });
  }

  private async handleEnterUserIdentifierSSO(
    prev: FlowTokenResultSuccess,
    username: string,
  ) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'LoginEnterUserIdentifierSSO',
          settings_list: {
            setting_responses: [
              {
                key: 'user_identifier',
                response_data: {
                  text_data: { result: username },
                },
              },
            ],
            link: 'next_link',
          },
        },
      ],
    });
  }

  private async handleEnterPassword(
    prev: FlowTokenResultSuccess,
    password: string,
  ) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'LoginEnterPassword',
          enter_password: {
            password,
            link: 'next_link',
          },
        },
      ],
    });
  }

  private async handleAccountDuplicationCheck(prev: FlowTokenResultSuccess) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'AccountDuplicationCheck',
          check_logged_in_account: {
            link: 'AccountDuplicationCheck_false',
          },
        },
      ],
    });
  }

  private async handleTwoFactorAuthChallenge(
    prev: FlowTokenResultSuccess,
    secret: string,
  ) {
    const totp = new OTPAuth.TOTP({ secret });
    let error;
    for (let attempts = 1; attempts < 4; attempts += 1) {
      try {
        return await this.executeFlowTask({
          flow_token: prev.flowToken,
          subtask_inputs: [
            {
              subtask_id: 'LoginTwoFactorAuthChallenge',
              enter_text: {
                link: 'next_link',
                text: totp.generate(),
              },
            },
          ],
        });
      } catch (err) {
        error = err;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
      }
    }
    throw error;
  }

  private async handleAcid(
    prev: FlowTokenResultSuccess,
    email: string | undefined,
  ) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [
        {
          subtask_id: 'LoginAcid',
          enter_text: {
            text: email,
            link: 'next_link',
          },
        },
      ],
    });
  }

  private async handleSuccessSubtask(prev: FlowTokenResultSuccess) {
    return await this.executeFlowTask({
      flow_token: prev.flowToken,
      subtask_inputs: [],
    });
  }

  private async executeFlowTask(
    data: TwitterUserAuthFlowRequest,
  ): Promise<FlowTokenResult> {
    const onboardingTaskUrl =
      'https://api.twitter.com/1.1/onboarding/task.json';

    const token = this.guestToken;
    if (token == null) {
      throw new Error('Authentication token is null or undefined.');
    }

    const headers = new Headers({
      authorization: `Bearer ${this.bearerToken}`,
      cookie: await this.getCookieString(),
      'content-type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
      'x-guest-token': token,
      'x-twitter-auth-type': 'OAuth2Client',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
    });
    await this.installCsrfToken(headers);

    const res = await this.fetch(onboardingTaskUrl, {
      credentials: 'include',
      method: 'POST',
      headers: headers,
      body: JSON.stringify(data),
    });

    await updateCookieJar(this.jar, res.headers);

    if (!res.ok) {
      return { status: 'error', err: new Error(await res.text()) };
    }

    const flow: TwitterUserAuthFlowResponse = await res.json();
    if (flow?.flow_token == null) {
      return { status: 'error', err: new Error('flow_token not found.') };
    }

    if (flow.errors?.length) {
      return {
        status: 'error',
        err: new Error(
          `Authentication error (${flow.errors[0].code}): ${flow.errors[0].message}`,
        ),
      };
    }

    if (typeof flow.flow_token !== 'string') {
      return {
        status: 'error',
        err: new Error('flow_token was not a string.'),
      };
    }

    const subtask = flow.subtasks?.length ? flow.subtasks[0] : undefined;
    Check(TwitterUserAuthSubtask, subtask);

    if (subtask && subtask.subtask_id === 'DenyLoginSubtask') {
      return {
        status: 'error',
        err: new Error('Authentication error: DenyLoginSubtask'),
      };
    }

    return {
      status: 'success',
      subtask,
      flowToken: flow.flow_token,
    };
  }
}
