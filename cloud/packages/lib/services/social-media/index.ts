import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { creditsService } from "@/lib/services/credits";
import { secretsService } from "@/lib/services/secrets";
import type {
  AccountAnalytics,
  CreatePostInput,
  GetAnalyticsInput,
  MediaAttachment,
  MultiPlatformPostResult,
  PlatformPostOptions,
  PostAnalytics,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
  SocialPlatform,
} from "@/lib/types/social-media";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import { alertOnPostFailure } from "./alerts";
import { blueskyProvider } from "./providers/bluesky";
import { discordProvider } from "./providers/discord";
import { linkedinProvider } from "./providers/linkedin";
import { mastodonProvider } from "./providers/mastodon";
import { metaProvider } from "./providers/meta";
import { redditProvider } from "./providers/reddit";
import { slackProvider } from "./providers/slack";
import { telegramProvider } from "./providers/telegram";
import { tiktokProvider } from "./providers/tiktok";
import { twitterProvider } from "./providers/twitter";
import { getRefreshGuidance, needsRefresh, refreshToken } from "./token-refresh";

const POST_CREDIT_COST = 0.01;

const providers: Record<SocialPlatform, SocialMediaProvider> = {
  twitter: twitterProvider,
  bluesky: blueskyProvider,
  discord: discordProvider,
  telegram: telegramProvider,
  slack: slackProvider,
  reddit: redditProvider,
  facebook: metaProvider,
  instagram: metaProvider,
  tiktok: tiktokProvider,
  linkedin: linkedinProvider,
  mastodon: mastodonProvider,
};

class SocialMediaService {
  getSupportedPlatforms(): SocialPlatform[] {
    return Object.entries(providers)
      .filter(([_, p]) => p !== null)
      .map(([platform]) => platform as SocialPlatform);
  }

  isPlatformSupported(platform: SocialPlatform): boolean {
    return providers[platform] !== null;
  }

  getProvider(platform: SocialPlatform): SocialMediaProvider {
    const provider = providers[platform];
    if (!provider) throw new Error(`Platform ${platform} is not supported`);
    return provider;
  }

  async getCredentialsForPlatform(
    organizationId: string,
    platform: SocialPlatform,
    credentialId?: string,
  ): Promise<SocialCredentials | null> {
    const conditions = [
      eq(platformCredentials.organization_id, organizationId),
      eq(platformCredentials.status, "active"),
      eq(platformCredentials.platform, platform),
    ];
    if (credentialId) conditions.push(eq(platformCredentials.id, credentialId));

    const [credential] = await dbRead
      .select()
      .from(platformCredentials)
      .where(and(...conditions))
      .limit(1);

    if (!credential) return this.getCredentialsFromSecrets(organizationId, platform);

    // Handle manual credentials (Bluesky app password, Telegram bot token)
    if (credential.api_key_secret_id) {
      const apiKey = await secretsService.getDecryptedValue(
        credential.api_key_secret_id,
        organizationId,
      );
      if (!apiKey) return this.getCredentialsFromSecrets(organizationId, platform);

      if (platform === "bluesky") {
        return {
          platform,
          handle: credential.platform_username ?? undefined,
          appPassword: apiKey,
          accountId: credential.platform_user_id,
        };
      }
      if (platform === "telegram") {
        return {
          platform,
          botToken: apiKey,
          accountId: credential.platform_user_id,
        };
      }
    }

    // Handle OAuth credentials
    const [accessToken, storedRefreshToken] = await Promise.all([
      credential.access_token_secret_id
        ? secretsService.getDecryptedValue(credential.access_token_secret_id, organizationId)
        : undefined,
      credential.refresh_token_secret_id
        ? secretsService.getDecryptedValue(credential.refresh_token_secret_id, organizationId)
        : undefined,
    ]);

    if (!accessToken) return this.getCredentialsFromSecrets(organizationId, platform);

    let credentials: SocialCredentials = {
      platform,
      accessToken,
      refreshToken: storedRefreshToken,
      tokenExpiresAt: credential.token_expires_at ?? undefined,
      username: credential.platform_username ?? undefined,
      accountId: credential.platform_user_id,
    };

    // For Mastodon, include instance URL from callback context
    if (platform === "mastodon") {
      const context = credential.source_context as {
        instanceUrl?: string;
      } | null;
      credentials.instanceUrl = context?.instanceUrl;
    }

    // Auto-refresh if token is expired
    if (needsRefresh(credentials)) {
      const refreshed = await refreshToken(platform, credentials).catch((err) => {
        logger.warn(`[SocialMedia] Token refresh failed for ${platform}: ${err.message}`);
        return null;
      });

      if (refreshed) {
        credentials = {
          ...credentials,
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
        };
        this.updateStoredToken(organizationId, credential.id, refreshed).catch((err) => {
          logger.error(`[SocialMedia] Failed to persist refreshed token: ${err.message}`);
        });
        logger.info(`[SocialMedia] Token refreshed for ${platform}`);
      } else {
        throw new Error(`Token expired. ${getRefreshGuidance(platform)}`);
      }
    }

    return credentials;
  }

  private async updateStoredToken(
    organizationId: string,
    credentialId: string,
    refreshed: { accessToken: string; refreshToken?: string; expiresAt?: Date },
  ): Promise<void> {
    const audit = {
      actorType: "system" as const,
      actorId: "token-refresh",
      source: "social-media-service",
    };

    // Store new access token
    const accessSecretId = await secretsService.create(
      {
        organizationId,
        name: `REFRESHED_ACCESS_TOKEN_${credentialId}`,
        value: refreshed.accessToken,
        scope: "organization",
        createdBy: "system",
      },
      audit,
    );

    const updates: Record<string, unknown> = {
      access_token_secret_id: accessSecretId,
      token_expires_at: refreshed.expiresAt,
      updated_at: new Date(),
    };

    if (refreshed.refreshToken) {
      const refreshSecretId = await secretsService.create(
        {
          organizationId,
          name: `REFRESHED_REFRESH_TOKEN_${credentialId}`,
          value: refreshed.refreshToken,
          scope: "organization",
          createdBy: "system",
        },
        audit,
      );
      updates.refresh_token_secret_id = refreshSecretId;
    }

    await dbWrite
      .update(platformCredentials)
      .set(updates)
      .where(eq(platformCredentials.id, credentialId));
  }

  private async getCredentialsFromSecrets(
    organizationId: string,
    platform: SocialPlatform,
  ): Promise<SocialCredentials | null> {
    const prefix = platform.toUpperCase();

    switch (platform) {
      case "twitter": {
        const [accessToken, refreshToken] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_ACCESS_TOKEN`),
          secretsService.get(organizationId, `${prefix}_REFRESH_TOKEN`),
        ]);
        if (!accessToken) return null;
        return {
          platform,
          accessToken,
          refreshToken: refreshToken ?? undefined,
        };
      }
      case "bluesky": {
        const [handle, appPassword] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_HANDLE`),
          secretsService.get(organizationId, `${prefix}_APP_PASSWORD`),
        ]);
        if (!handle || !appPassword) return null;
        return { platform, handle, appPassword };
      }
      case "discord": {
        const [botToken, webhookUrl] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_BOT_TOKEN`),
          secretsService.get(organizationId, `${prefix}_WEBHOOK_URL`),
        ]);
        if (!botToken && !webhookUrl) return null;
        return {
          platform,
          botToken: botToken ?? undefined,
          webhookUrl: webhookUrl ?? undefined,
        };
      }
      case "telegram": {
        const botToken = await secretsService.get(organizationId, `${prefix}_BOT_TOKEN`);
        if (!botToken) return null;
        return { platform, botToken };
      }
      case "reddit": {
        const [apiKey, apiSecret, username, password] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_CLIENT_ID`),
          secretsService.get(organizationId, `${prefix}_CLIENT_SECRET`),
          secretsService.get(organizationId, `${prefix}_USERNAME`),
          secretsService.get(organizationId, `${prefix}_PASSWORD`),
        ]);
        if (!apiKey || !apiSecret || !username || !password) return null;
        return { platform, apiKey, apiSecret, username, password };
      }
      case "tiktok":
      case "linkedin": {
        const accessToken = await secretsService.get(organizationId, `${prefix}_ACCESS_TOKEN`);
        if (!accessToken) return null;
        return { platform, accessToken };
      }
      case "facebook":
      case "instagram": {
        const [accessToken, pageId, accountId] = await Promise.all([
          secretsService.get(organizationId, `META_ACCESS_TOKEN`),
          secretsService.get(organizationId, `META_PAGE_ID`),
          secretsService.get(organizationId, `META_IG_ACCOUNT_ID`),
        ]);
        if (!accessToken) return null;
        return {
          platform,
          accessToken,
          pageId: pageId ?? undefined,
          accountId: accountId ?? undefined,
        };
      }
      case "mastodon": {
        const [accessToken, instanceUrl] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_ACCESS_TOKEN`),
          secretsService.get(organizationId, `${prefix}_INSTANCE_URL`),
        ]);
        if (!accessToken) return null;
        return { platform, accessToken, instanceUrl: instanceUrl ?? undefined };
      }
      case "slack": {
        const [botToken, webhookUrl] = await Promise.all([
          secretsService.get(organizationId, `${prefix}_BOT_TOKEN`),
          secretsService.get(organizationId, `${prefix}_WEBHOOK_URL`),
        ]);
        if (!botToken && !webhookUrl) return null;
        return {
          platform,
          botToken: botToken ?? undefined,
          webhookUrl: webhookUrl ?? undefined,
        };
      }
      default:
        return null;
    }
  }

  async createPost(input: CreatePostInput): Promise<MultiPlatformPostResult> {
    const { organizationId, userId, content, platforms, platformOptions, credentialIds } = input;

    logger.info("[SocialMedia] Creating post", {
      organizationId,
      platforms,
      hasMedia: !!content.media?.length,
    });

    const totalCost = platforms.length * POST_CREDIT_COST;
    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: totalCost,
      description: `Social media post to ${platforms.join(", ")}`,
      metadata: { userId, platforms },
    });

    if (!deduction.success) throw new Error(`Insufficient credits: need $${totalCost.toFixed(4)}`);

    const results = await Promise.all(
      platforms.map(async (platform): Promise<PostResult> => {
        const provider = providers[platform];
        if (!provider)
          return {
            platform,
            success: false,
            error: `Platform ${platform} is not supported`,
          };

        const credentials = await this.getCredentialsForPlatform(
          organizationId,
          platform,
          credentialIds?.[platform],
        );
        if (!credentials)
          return {
            platform,
            success: false,
            error: `No credentials found for ${platform}`,
          };

        try {
          return await provider.createPost(credentials, content, platformOptions);
        } catch (error) {
          const errorMessage = extractErrorMessage(error);
          logger.error("[SocialMedia] Post failed", {
            platform,
            error: errorMessage,
          });
          return { platform, success: false, error: errorMessage };
        }
      }),
    );

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    if (failed.length > 0) {
      await creditsService.refundCredits({
        organizationId,
        amount: failed.length * POST_CREDIT_COST,
        description: `Refund for failed posts: ${failed.map((f) => f.platform).join(", ")}`,
        metadata: { userId, failedPlatforms: failed.map((f) => f.platform) },
      });

      alertOnPostFailure(
        organizationId,
        failed.map((f) => f.platform),
        failed.map((f) => f.error || "Unknown error"),
      ).catch((err) => {
        logger.error(`[SocialMedia] Failed to send alert: ${err.message}`);
      });
    }

    logger.info("[SocialMedia] Post complete", {
      organizationId,
      successCount: successful.length,
      failureCount: failed.length,
    });

    return {
      results,
      successful,
      failed,
      totalPlatforms: platforms.length,
      successCount: successful.length,
      failureCount: failed.length,
    };
  }

  async deletePost(
    organizationId: string,
    platform: SocialPlatform,
    postId: string,
    credentialId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const provider = this.getProvider(platform);
    if (!provider.deletePost)
      return { success: false, error: `Delete not supported for ${platform}` };

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) return { success: false, error: `No credentials found for ${platform}` };

    return provider.deletePost(credentials, postId);
  }

  async getPostAnalytics(input: GetAnalyticsInput): Promise<PostAnalytics | null> {
    const { organizationId, platform, postId, credentialId } = input;
    if (!postId) throw new Error("postId is required for post analytics");

    const provider = this.getProvider(platform);
    if (!provider.getPostAnalytics) return null;

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) throw new Error(`No credentials found for ${platform}`);

    return provider.getPostAnalytics(credentials, postId);
  }

  async getAccountAnalytics(
    input: Omit<GetAnalyticsInput, "postId">,
  ): Promise<AccountAnalytics | null> {
    const { organizationId, platform, credentialId } = input;

    const provider = this.getProvider(platform);
    if (!provider.getAccountAnalytics) return null;

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) throw new Error(`No credentials found for ${platform}`);

    return provider.getAccountAnalytics(credentials);
  }

  async uploadMedia(
    organizationId: string,
    platform: SocialPlatform,
    media: MediaAttachment,
    credentialId?: string,
  ): Promise<{ mediaId: string; url?: string }> {
    const provider = this.getProvider(platform);
    if (!provider.uploadMedia) throw new Error(`Media upload not supported for ${platform}`);

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) throw new Error(`No credentials found for ${platform}`);

    return provider.uploadMedia(credentials, media);
  }

  async replyToPost(
    organizationId: string,
    platform: SocialPlatform,
    postId: string,
    content: PostContent,
    options?: PlatformPostOptions,
    credentialId?: string,
  ): Promise<PostResult> {
    const provider = this.getProvider(platform);
    if (!provider.replyToPost)
      return {
        platform,
        success: false,
        error: `Reply not supported for ${platform}`,
      };

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials)
      return {
        platform,
        success: false,
        error: `No credentials found for ${platform}`,
      };

    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: POST_CREDIT_COST,
      description: `Social media reply on ${platform}`,
      metadata: { platform, postId },
    });

    if (!deduction.success) return { platform, success: false, error: "Insufficient credits" };

    const result = await provider.replyToPost(credentials, postId, content, options);

    if (!result.success) {
      await creditsService.refundCredits({
        organizationId,
        amount: POST_CREDIT_COST,
        description: `Refund for failed reply on ${platform}`,
        metadata: { platform, postId },
      });
    }

    return result;
  }

  async likePost(
    organizationId: string,
    platform: SocialPlatform,
    postId: string,
    credentialId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const provider = this.getProvider(platform);
    if (!provider.likePost) return { success: false, error: `Like not supported for ${platform}` };

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) return { success: false, error: `No credentials found for ${platform}` };

    return provider.likePost(credentials, postId);
  }

  async repost(
    organizationId: string,
    platform: SocialPlatform,
    postId: string,
    credentialId?: string,
  ): Promise<PostResult> {
    const provider = this.getProvider(platform);
    if (!provider.repost)
      return {
        platform,
        success: false,
        error: `Repost not supported for ${platform}`,
      };

    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials)
      return {
        platform,
        success: false,
        error: `No credentials found for ${platform}`,
      };

    return provider.repost(credentials, postId);
  }

  async validateCredentials(
    organizationId: string,
    platform: SocialPlatform,
    credentialId?: string,
  ): Promise<{
    valid: boolean;
    accountId?: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
    error?: string;
  }> {
    const provider = this.getProvider(platform);
    const credentials = await this.getCredentialsForPlatform(
      organizationId,
      platform,
      credentialId,
    );
    if (!credentials) return { valid: false, error: `No credentials found for ${platform}` };

    return provider.validateCredentials(credentials);
  }

  async storeCredentials(
    organizationId: string,
    userId: string,
    platform: SocialPlatform,
    credentials: Partial<SocialCredentials>,
  ): Promise<void> {
    const prefix = platform.toUpperCase();
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "social-media-service",
    };

    const fieldMap: Record<string, string> = {
      accessToken: "ACCESS_TOKEN",
      refreshToken: "REFRESH_TOKEN",
      botToken: "BOT_TOKEN",
      apiKey: "CLIENT_ID",
      apiSecret: "CLIENT_SECRET",
      username: "USERNAME",
      password: "PASSWORD",
      email: "EMAIL",
      handle: "HANDLE",
      appPassword: "APP_PASSWORD",
      webhookUrl: "WEBHOOK_URL",
    };

    const entries = Object.entries(fieldMap)
      .filter(([field]) => credentials[field as keyof SocialCredentials])
      .map(([field, suffix]) => ({
        name: `${prefix}_${suffix}`,
        value: credentials[field as keyof SocialCredentials] as string,
      }));

    await Promise.all(
      entries.map(({ name, value }) =>
        secretsService.create(
          {
            organizationId,
            name,
            value,
            scope: "organization",
            createdBy: userId,
          },
          audit,
        ),
      ),
    );

    logger.info("[SocialMedia] Credentials stored", {
      organizationId,
      platform,
    });
  }
}

export const socialMediaService = new SocialMediaService();
export * from "@/lib/types/social-media";
