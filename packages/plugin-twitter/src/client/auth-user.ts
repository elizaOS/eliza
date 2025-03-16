import { type Static, Type } from '@sinclair/typebox';
import { Check } from '@sinclair/typebox/value';
import { Headers } from 'headers-polyfill';
import * as OTPAuth from 'otpauth';
import { CookieJar } from 'tough-cookie';
import { requestApi } from './api';
import { type TwitterAuthOptions, TwitterGuestAuth } from './auth';
import type { TwitterApiErrorRaw } from './errors';
import { type LegacyUserRaw, type Profile, parseProfile } from './profile';
import { updateCookieJar } from './requests';

/**
 * Interface representing the init request for a Twitter user authentication flow.
 * @typedef {Object} TwitterUserAuthFlowInitRequest
 * @property {string} flow_name - The name of the flow.
 * @property {Record<string, unknown>} input_flow_data - The input flow data.
 */
interface TwitterUserAuthFlowInitRequest {
  flow_name: string;
  input_flow_data: Record<string, unknown>;
}

/**
 * Interface representing a request for a subtask in the Twitter user authentication flow.
 * @typedef {object} TwitterUserAuthFlowSubtaskRequest
 * @property {string} flow_token - The token representing the flow.
 * @property {object[]} subtask_inputs - An array of subtask inputs, each containing a subtask ID and other unknown properties.
 */
interface TwitterUserAuthFlowSubtaskRequest {
  flow_token: string;
  subtask_inputs: ({
    subtask_id: string;
  } & Record<string, unknown>)[];
}

/**
 * Represents a request for a Twitter user authentication flow, which can be either an init request
 * or a subtask request.
 */

type TwitterUserAuthFlowRequest =
  | TwitterUserAuthFlowInitRequest
  | TwitterUserAuthFlowSubtaskRequest;

/**
 * Interface representing the response object of the Twitter user authentication flow.
 * @property {TwitterApiErrorRaw[]} [errors] The errors occurred during the authentication flow.
 * @property {string} [flow_token] The token associated with the authentication flow.
 * @property {string} [status] The status of the authentication flow.
 * @property {TwitterUserAuthSubtask[]} [subtasks] The subtasks involved in the authentication flow.
 */
interface TwitterUserAuthFlowResponse {
  errors?: TwitterApiErrorRaw[];
  flow_token?: string;
  status?: string;
  subtasks?: TwitterUserAuthSubtask[];
}

/**
 * Interface representing the response structure for verifying Twitter user authentication credentials.
 *
 * @property {TwitterApiErrorRaw[]} [errors] Optional array of Twitter API errors.
 */
interface TwitterUserAuthVerifyCredentials {
  errors?: TwitterApiErrorRaw[];
}

const TwitterUserAuthSubtask = Type.Object({
  subtask_id: Type.String(),
  enter_text: Type.Optional(Type.Object({})),
});
/**
 * Represents the type of a Twitter user authentication subtask.
 */
type TwitterUserAuthSubtask = Static<typeof TwitterUserAuthSubtask>;

/**
 * Represents the result of a successful flow token generation.
 * @typedef {Object} FlowTokenResultSuccess
 * @property {string} status - The status of the result (always "success").
 * @property {string} flowToken - The generated flow token.
 * @property {TwitterUserAuthSubtask} [subtask] - Optional subtask related to Twitter user authentication.
 */
type FlowTokenResultSuccess = {
  status: 'success';
  flowToken: string;
  subtask?: TwitterUserAuthSubtask;
};

/**
 * Represents the result of a FlowToken operation, which can either be a success with the token or an error with the error details.
 * @typedef {FlowTokenResultSuccess | { status: "error"; err: Error }} FlowTokenResult
 */
type FlowTokenResult = FlowTokenResultSuccess | { status: 'error'; err: Error };

/**
 * A user authentication token manager.
 */
/**
 * Class representing Twitter User Authentication.
 * Extends TwitterGuestAuth class.
 */
export class TwitterUserAuth extends TwitterGuestAuth {
  private userProfile: Profile | undefined;

  async isLoggedIn(): Promise<boolean> {
    const res = await requestApi<TwitterUserAuthVerifyCredentials>(
      'https://api.twitter.com/1.1/account/verify_credentials.json',
      this
    );
    if (!res.success) {
      return false;
    }

    const { value: verify } = res;
    this.userProfile = parseProfile(
      verify as LegacyUserRaw,
      (verify as unknown as { verified: boolean }).verified
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
    accessSecret?: string
  ): Promise<void> {
    await this.updateGuestToken();

    let next = await this.initLogin();
    while ('subtask' in next && next.subtask) {
      if (next.subtask.subtask_id === 'LoginJsInstrumentationSubtask') {
        next = await this.handleJsInstrumentationSubtask(next);
      } else if (next.subtask.subtask_id === 'LoginEnterUserIdentifierSSO') {
        next = await this.handleEnterUserIdentifierSSO(next, username);
      } else if (next.subtask.subtask_id === 'LoginEnterAlternateIdentifierSubtask') {
        next = await this.handleEnterAlternateIdentifierSubtask(next, email as string);
      } else if (next.subtask.subtask_id === 'LoginEnterPassword') {
        next = await this.handleEnterPassword(next, password);
      } else if (next.subtask.subtask_id === 'AccountDuplicationCheck') {
        next = await this.handleAccountDuplicationCheck(next);
      } else if (next.subtask.subtask_id === 'LoginTwoFactorAuthChallenge') {
        if (twoFactorSecret) {
          next = await this.handleTwoFactorAuthChallenge(next, twoFactorSecret);
        } else {
          throw new Error('Requested two factor authentication code but no secret provided');
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

    await requestApi<void>('https://api.twitter.com/1.1/account/logout.json', this, 'POST');
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

  private async handleEnterAlternateIdentifierSubtask(prev: FlowTokenResultSuccess, email: string) {
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

  private async handleEnterUserIdentifierSSO(prev: FlowTokenResultSuccess, username: string) {
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

  private async handleEnterPassword(prev: FlowTokenResultSuccess, password: string) {
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

  private async handleTwoFactorAuthChallenge(prev: FlowTokenResultSuccess, secret: string) {
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

  private async handleAcid(prev: FlowTokenResultSuccess, email: string | undefined) {
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

  private async executeFlowTask(data: TwitterUserAuthFlowRequest): Promise<FlowTokenResult> {
    const onboardingTaskUrl = 'https://api.twitter.com/1.1/onboarding/task.json';

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
        err: new Error(`Authentication error (${flow.errors[0].code}): ${flow.errors[0].message}`),
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
