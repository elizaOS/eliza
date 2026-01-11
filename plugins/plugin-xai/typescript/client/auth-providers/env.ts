import type { IAgentRuntime } from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { OAuth1Credentials, XOAuth1Provider } from "./types";

/**
 * Env-var auth provider (OAuth 1.0a user context).
 *
 * Configuration:
 * - X_API_KEY
 * - X_API_SECRET
 * - X_ACCESS_TOKEN
 * - X_ACCESS_TOKEN_SECRET
 */
export class EnvAuthProvider implements XOAuth1Provider {
  readonly mode = "env" as const;

  constructor(
    private readonly runtime?: IAgentRuntime,
    private readonly state?: Record<string, unknown>
  ) {}

  async getOAuth1Credentials(): Promise<OAuth1Credentials> {
    const apiKeyRaw = this.state?.X_API_KEY ?? getSetting(this.runtime, "X_API_KEY");
    const apiSecretKeyRaw = this.state?.X_API_SECRET ?? getSetting(this.runtime, "X_API_SECRET");
    const accessTokenRaw = this.state?.X_ACCESS_TOKEN ?? getSetting(this.runtime, "X_ACCESS_TOKEN");
    const accessTokenSecretRaw =
      this.state?.X_ACCESS_TOKEN_SECRET ?? getSetting(this.runtime, "X_ACCESS_TOKEN_SECRET");

    const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw : undefined;
    const apiSecretKey = typeof apiSecretKeyRaw === "string" ? apiSecretKeyRaw : undefined;
    const accessToken = typeof accessTokenRaw === "string" ? accessTokenRaw : undefined;
    const accessTokenSecret =
      typeof accessTokenSecretRaw === "string" ? accessTokenSecretRaw : undefined;

    const missing: string[] = [];
    if (!apiKey) missing.push("X_API_KEY");
    if (!apiSecretKey) missing.push("X_API_SECRET");
    if (!accessToken) missing.push("X_ACCESS_TOKEN");
    if (!accessTokenSecret) missing.push("X_ACCESS_TOKEN_SECRET");
    if (missing.length) {
      throw new Error(`Missing required X env credentials: ${missing.join(", ")}`);
    }

    if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
      throw new Error("X credentials validation failed");
    }

    return {
      appKey: apiKey,
      appSecret: apiSecretKey,
      accessToken: accessToken,
      accessSecret: accessTokenSecret,
    };
  }

  async getAccessToken(): Promise<string> {
    const creds = await this.getOAuth1Credentials();
    return creds.accessToken;
  }
}
