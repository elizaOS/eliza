import type { IAgentRuntime } from "@elizaos/core";

export type TwitterAuthMode = "env" | "oauth" | "broker";

/**
 * Primary abstraction: obtain a valid access token for Twitter/X API calls.
 *
 * - For OAuth2 PKCE mode, this is the OAuth2 user access token (Bearer).
 * - For env mode (legacy OAuth1.0a), this returns the OAuth1 access token string
 *   (and the provider may expose additional fields via `getOAuth1Credentials()`).
 */
export interface TwitterAuthProvider {
  readonly mode: TwitterAuthMode;

  /**
   * Returns a valid access token string.
   * Implementations should refresh/reauth as needed.
   */
  getAccessToken(): Promise<string>;
}

export interface OAuth1Credentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * Optional capability used to keep full backward compatibility with the existing OAuth1.0a flow.
 * Consumers should not depend on this unless they need OAuth1 signing.
 */
export interface TwitterOAuth1Provider extends TwitterAuthProvider {
  getOAuth1Credentials(): Promise<OAuth1Credentials>;
}

export interface TwitterAuthProviderFactoryOptions {
  runtime: IAgentRuntime;
  state?: any;
}

