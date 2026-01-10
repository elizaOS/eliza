import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { OAuth1Credentials, TwitterOAuth1Provider } from "./types";

/**
 * Legacy env-var auth provider (OAuth 1.0a user context).
 *
 * Backward compatible with the existing configuration:
 * - TWITTER_API_KEY
 * - TWITTER_API_SECRET_KEY
 * - TWITTER_ACCESS_TOKEN
 * - TWITTER_ACCESS_TOKEN_SECRET
 */
export class EnvAuthProvider implements TwitterOAuth1Provider {
  readonly mode = "env" as const;

  constructor(
    private readonly runtime?: IAgentRuntime,
    private readonly state?: any,
  ) {}

  async getOAuth1Credentials(): Promise<OAuth1Credentials> {
    const apiKey =
      this.state?.TWITTER_API_KEY ?? getSetting(this.runtime, "TWITTER_API_KEY");
    const apiSecretKey =
      this.state?.TWITTER_API_SECRET_KEY ??
      getSetting(this.runtime, "TWITTER_API_SECRET_KEY");
    const accessToken =
      this.state?.TWITTER_ACCESS_TOKEN ??
      getSetting(this.runtime, "TWITTER_ACCESS_TOKEN");
    const accessTokenSecret =
      this.state?.TWITTER_ACCESS_TOKEN_SECRET ??
      getSetting(this.runtime, "TWITTER_ACCESS_TOKEN_SECRET");

    const missing: string[] = [];
    if (!apiKey) missing.push("TWITTER_API_KEY");
    if (!apiSecretKey) missing.push("TWITTER_API_SECRET_KEY");
    if (!accessToken) missing.push("TWITTER_ACCESS_TOKEN");
    if (!accessTokenSecret) missing.push("TWITTER_ACCESS_TOKEN_SECRET");
    if (missing.length) {
      throw new Error(
        `Missing required Twitter env credentials: ${missing.join(", ")}`,
      );
    }

    return {
      appKey: apiKey,
      appSecret: apiSecretKey,
      accessToken,
      accessSecret: accessTokenSecret,
    };
  }

  async getAccessToken(): Promise<string> {
    const creds = await this.getOAuth1Credentials();
    return creds.accessToken;
  }
}

