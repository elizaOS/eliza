/**
 * `TwitterAuth` — lazily materializes a twitter-api-v2 `TwitterApi` from a
 * `TwitterAuthProvider`, transparently supporting both auth modes: OAuth 1.0a
 * (built from the provider's four static credentials) and OAuth 2.0 user-context
 * (a Bearer access token that is refreshed when the provider hands back a new one).
 * Caches the authenticated `me()` profile and is the object `Client.getV2Client()`
 * hands the raw v2 client from.
 */
import { ElizaError, logger } from "@elizaos/core";
import { TwitterApi } from "twitter-api-v2";
import type {
  TwitterAuthProvider,
  TwitterOAuth1Provider,
} from "./auth-providers/types";
import type { Profile } from "./profile";

/**
 * Twitter API v2 authentication using developer credentials
 */
export class TwitterAuth {
  private v2Client: TwitterApi | null = null;
  private authenticated = false;
  private profile?: Profile;
  private loggedOut = false;

  private lastAccessToken?: string;

  constructor(private readonly provider: TwitterAuthProvider) {
    if (this.isOAuth1Provider(provider)) {
      this.authenticated = true;
    }
  }

  private isOAuth1Provider(p: TwitterAuthProvider): p is TwitterOAuth1Provider {
    const candidate = p as { getOAuth1Credentials?: unknown };
    return typeof candidate.getOAuth1Credentials === "function";
  }

  private async ensureClientInitialized(): Promise<void> {
    if (this.loggedOut) {
      throw new Error("Twitter API client not initialized");
    }
    if (this.isOAuth1Provider(this.provider)) {
      if (this.v2Client) return;
      const creds = await this.provider.getOAuth1Credentials();
      this.v2Client = new TwitterApi({
        appKey: creds.appKey,
        appSecret: creds.appSecret,
        accessToken: creds.accessToken,
        accessSecret: creds.accessSecret,
      });
      this.authenticated = true;
      this.lastAccessToken = creds.accessToken;
      return;
    }

    const token = await this.provider.getAccessToken();
    if (!this.v2Client || this.lastAccessToken !== token) {
      // OAuth2 user context token: Bearer token
      this.v2Client = new TwitterApi(token);
      this.authenticated = true;
      this.lastAccessToken = token;
    }
  }

  /**
   * Get the Twitter API v2 client
   */
  async getV2Client(): Promise<TwitterApi> {
    await this.ensureClientInitialized();
    if (!this.v2Client) {
      throw new Error("Twitter API client not initialized");
    }
    return this.v2Client;
  }

  /**
   * Check if authenticated
   */
  async isLoggedIn(): Promise<boolean> {
    // error-policy:J4 availability probe — this method's contract is a boolean
    // "are we authenticated" answer, so any init/verify failure is the designed
    // false, not a masked read. Callers that need the failure call me() instead.
    try {
      await this.ensureClientInitialized();
    } catch {
      return false;
    }
    if (!this.authenticated || !this.v2Client) {
      return false;
    }

    try {
      // Verify credentials by getting current user
      const me = await this.v2Client.v2.me();
      return !!me.data;
    } catch (error) {
      // error-policy:J4 availability probe — a failed verify means "not logged
      // in" for this boolean; log for diagnostics and report the designed false.
      logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        "[X.TwitterAuth] credential verification failed; reporting not-logged-in",
      );
      return false;
    }
  }

  /**
   * Get current user profile
   */
  async me(): Promise<Profile | undefined> {
    if (this.profile) {
      return this.profile;
    }

    await this.ensureClientInitialized();
    if (!this.v2Client) {
      throw new Error("Not authenticated");
    }

    try {
      const { data: user } = await this.v2Client.v2.me({
        "user.fields": [
          "id",
          "name",
          "username",
          "description",
          "profile_image_url",
          "public_metrics",
          "verified",
          "location",
          "created_at",
        ],
      });

      this.profile = {
        userId: user.id,
        username: user.username,
        name: user.name,
        biography: user.description,
        avatar: user.profile_image_url,
        followersCount: user.public_metrics?.followers_count,
        followingCount: user.public_metrics?.following_count,
        isVerified: user.verified,
        location: user.location || "",
        joined: user.created_at ? new Date(user.created_at) : undefined,
      };

      return this.profile;
    } catch (error) {
      throw new ElizaError("Failed to fetch authenticated user profile", {
        code: "X_ME_FETCH_FAILED",
        cause: error,
      });
    }
  }

  /**
   * Logout (clear credentials)
   */
  async logout(): Promise<void> {
    this.v2Client = null;
    this.authenticated = false;
    this.profile = undefined;
    this.lastAccessToken = undefined;
    this.loggedOut = true;
  }

  hasToken(): boolean {
    return this.authenticated && !this.loggedOut;
  }
}
