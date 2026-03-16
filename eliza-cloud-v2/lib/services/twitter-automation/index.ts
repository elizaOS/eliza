/**
 * Twitter Automation Service
 *
 * Handles OAuth 1.0a flow for Twitter plugin integration.
 * The plugin requires OAuth 1.0a credentials:
 * - TWITTER_API_KEY + TWITTER_API_SECRET_KEY (from platform app, stored in env)
 * - TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET (per-user, from OAuth flow)
 */

import { TwitterApi } from "twitter-api-v2";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";

// Platform app credentials from environment
const TWITTER_API_KEY = process.env.TWITTER_API_KEY!;
const TWITTER_API_SECRET_KEY = process.env.TWITTER_API_SECRET_KEY!;

export interface TwitterOAuthState {
  oauthToken: string;
  oauthTokenSecret: string;
  organizationId: string;
  userId: string;
  redirectUrl?: string;
}

export interface TwitterConnectionStatus {
  connected: boolean;
  username?: string;
  userId?: string;
  avatarUrl?: string;
  error?: string;
}

export interface TwitterAutomationSettings {
  enabled: boolean;
  autoPost: boolean;
  autoReply: boolean;
  autoEngage: boolean;
  discovery: boolean;
  postIntervalMin: number;
  postIntervalMax: number;
  dryRun: boolean;
  targetUsers?: string;
}

class TwitterAutomationService {
  /**
   * Generate OAuth 1.0a authorization URL
   * Step 1 of the 3-legged OAuth flow
   */
  async generateAuthLink(callbackUrl: string): Promise<{
    url: string;
    oauthToken: string;
    oauthTokenSecret: string;
  }> {
    if (!TWITTER_API_KEY || !TWITTER_API_SECRET_KEY) {
      throw new Error(
        "Twitter API credentials not configured. Set TWITTER_API_KEY and TWITTER_API_SECRET_KEY in environment.",
      );
    }

    const client = new TwitterApi({
      appKey: TWITTER_API_KEY,
      appSecret: TWITTER_API_SECRET_KEY,
    });

    const authLink = await client.generateAuthLink(callbackUrl, {
      linkMode: "authorize",
    });

    logger.info("[TwitterAutomation] Generated auth link", {
      oauthToken: authLink.oauth_token,
    });

    return {
      url: authLink.url,
      oauthToken: authLink.oauth_token,
      oauthTokenSecret: authLink.oauth_token_secret,
    };
  }

  /**
   * Exchange OAuth verifier for access tokens
   * Step 3 of the 3-legged OAuth flow (after user authorizes)
   */
  async exchangeToken(
    oauthToken: string,
    oauthTokenSecret: string,
    oauthVerifier: string,
  ): Promise<{
    accessToken: string;
    accessSecret: string;
    screenName: string;
    userId: string;
  }> {
    if (!TWITTER_API_KEY || !TWITTER_API_SECRET_KEY) {
      throw new Error("Twitter API credentials not configured");
    }

    const client = new TwitterApi({
      appKey: TWITTER_API_KEY,
      appSecret: TWITTER_API_SECRET_KEY,
      accessToken: oauthToken,
      accessSecret: oauthTokenSecret,
    });

    const loginResult = await client.login(oauthVerifier);

    logger.info("[TwitterAutomation] Token exchange successful", {
      screenName: loginResult.screenName,
      userId: loginResult.userId,
    });

    return {
      accessToken: loginResult.accessToken,
      accessSecret: loginResult.accessSecret,
      screenName: loginResult.screenName,
      userId: loginResult.userId,
    };
  }

  /**
   * Store user's Twitter credentials in secrets
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: {
      accessToken: string;
      accessSecret: string;
      screenName: string;
      twitterUserId: string;
    },
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twitter-automation",
    };

    // Store access token
    await secretsService.create(
      {
        organizationId,
        name: "TWITTER_ACCESS_TOKEN",
        value: credentials.accessToken,
        scope: "organization",
        createdBy: userId,
      },
      audit,
    );

    // Store access token secret
    await secretsService.create(
      {
        organizationId,
        name: "TWITTER_ACCESS_TOKEN_SECRET",
        value: credentials.accessSecret,
        scope: "organization",
        createdBy: userId,
      },
      audit,
    );

    // Store username for display
    await secretsService.create(
      {
        organizationId,
        name: "TWITTER_USERNAME",
        value: credentials.screenName,
        scope: "organization",
        createdBy: userId,
      },
      audit,
    );

    // Store Twitter user ID
    await secretsService.create(
      {
        organizationId,
        name: "TWITTER_USER_ID",
        value: credentials.twitterUserId,
        scope: "organization",
        createdBy: userId,
      },
      audit,
    );

    logger.info("[TwitterAutomation] Credentials stored", {
      organizationId,
      screenName: credentials.screenName,
    });
  }

  /**
   * Remove Twitter credentials (disconnect)
   */
  async removeCredentials(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "twitter-automation",
    };

    const secretNames = [
      "TWITTER_ACCESS_TOKEN",
      "TWITTER_ACCESS_TOKEN_SECRET",
      "TWITTER_USERNAME",
      "TWITTER_USER_ID",
    ];

    await Promise.all(
      secretNames.map((name) =>
        secretsService
          .deleteByName(organizationId, name, audit)
          .catch(() => {
            // Ignore if secret doesn't exist
          }),
      ),
    );

    logger.info("[TwitterAutomation] Credentials removed", { organizationId });
  }

  /**
   * Check if Twitter is connected for an organization
   */
  async getConnectionStatus(
    organizationId: string,
  ): Promise<TwitterConnectionStatus> {
    const [accessToken, accessSecret, username, twitterUserId] =
      await Promise.all([
        secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN"),
        secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN_SECRET"),
        secretsService.get(organizationId, "TWITTER_USERNAME"),
        secretsService.get(organizationId, "TWITTER_USER_ID"),
      ]);

    if (!accessToken || !accessSecret) {
      return { connected: false };
    }

    // Optionally validate the token is still valid
    try {
      const client = new TwitterApi({
        appKey: TWITTER_API_KEY,
        appSecret: TWITTER_API_SECRET_KEY,
        accessToken,
        accessSecret,
      });

      const me = await client.v2.me({
        "user.fields": ["profile_image_url"],
      });

      return {
        connected: true,
        username: me.data.username,
        userId: me.data.id,
        avatarUrl: me.data.profile_image_url,
      };
    } catch (error) {
      logger.warn("[TwitterAutomation] Token validation failed", {
        organizationId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Return stored data even if validation fails
      return {
        connected: true,
        username: username ?? undefined,
        userId: twitterUserId ?? undefined,
        error: "Token may be expired. Try reconnecting.",
      };
    }
  }

  /**
   * Get credentials for injecting into character settings
   * Used by agent-loader when Twitter is enabled
   */
  async getCredentialsForAgent(
    organizationId: string,
  ): Promise<Record<string, string> | null> {
    const [accessToken, accessSecret] = await Promise.all([
      secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN"),
      secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN_SECRET"),
    ]);

    if (!accessToken || !accessSecret) {
      return null;
    }

    // Return credentials that the plugin expects
    return {
      TWITTER_API_KEY,
      TWITTER_API_SECRET_KEY,
      TWITTER_ACCESS_TOKEN: accessToken,
      TWITTER_ACCESS_TOKEN_SECRET: accessSecret,
    };
  }

  /**
   * Check if Twitter API credentials are configured at platform level
   */
  isConfigured(): boolean {
    return Boolean(TWITTER_API_KEY && TWITTER_API_SECRET_KEY);
  }
}

export const twitterAutomationService = new TwitterAutomationService();

// Re-export app automation service
export {
  twitterAppAutomationService,
  type TwitterAutomationConfig,
  type GeneratedTweet,
} from "./app-automation";
