import { TwitterApi } from "twitter-api-v2";
import type { XAuthProvider, XOAuth1Provider } from "./auth-providers/types";
import type { Profile } from "./profile";

/**
 * X API v2 authentication using developer credentials
 */
export class XAuth {
  private v2Client: TwitterApi | null = null;
  private authenticated = false;
  private profile?: Profile;
  private loggedOut = false;

  private lastAccessToken?: string;

  constructor(private readonly provider: XAuthProvider) {
    // OAuth1 provider is considered authenticated immediately
    if ("getOAuth1Credentials" in provider && typeof provider.getOAuth1Credentials === "function") {
      this.authenticated = true;
    }
  }

  private isOAuth1Provider(p: XAuthProvider): p is XOAuth1Provider {
    return "getOAuth1Credentials" in p && typeof p.getOAuth1Credentials === "function";
  }

  private async ensureClientInitialized(): Promise<void> {
    if (this.loggedOut) {
      throw new Error("X API client not initialized");
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
   * Get the X API v2 client
   */
  async getV2Client(): Promise<TwitterApi> {
    await this.ensureClientInitialized();
    if (!this.v2Client) {
      throw new Error("X API client not initialized");
    }
    return this.v2Client;
  }

  /**
   * Check if authenticated
   */
  async isLoggedIn(): Promise<boolean> {
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
      console.error("Failed to verify authentication:", error);
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
      console.error("Failed to get user profile:", error);
      return undefined;
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

  /**
   * For compatibility - always returns true since we use API keys
   */
  hasToken(): boolean {
    return this.authenticated && !this.loggedOut;
  }
}
