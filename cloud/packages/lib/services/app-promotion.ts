import { generateText } from "ai";
import type { App } from "@/db/repositories";
// Note: When ANTHROPIC_COT_BUDGET is set and model is Anthropic, temperature is silently dropped
// per @ai-sdk/anthropic behavior. This service uses temperature for creative copy generation.
import {
  AD_COPY_GENERATION_COST,
  DISCORD_AUTOMATION_SETUP_COST,
  DISCORD_POST_COST,
  TELEGRAM_AUTOMATION_SETUP_COST,
  TELEGRAM_POST_COST,
  TWITTER_AUTOMATION_SETUP_COST,
  TWITTER_POST_COST,
} from "@/lib/promotion-pricing";
import { mergeAnthropicCotProviderOptions } from "@/lib/providers/anthropic-thinking";
import { getLanguageModel } from "@/lib/providers/language-model";
import type { PostContent, SocialPlatform } from "@/lib/types/social-media";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import { advertisingService } from "./advertising";
import type { AdPlatform } from "./advertising/types";
import { appsService } from "./apps";
import { creditsService } from "./credits";
import { discordAppAutomationService } from "./discord-automation/app-automation";
import type { CreateSeoRequestParams } from "./seo";
import { seoService } from "./seo";
import { socialMediaService } from "./social-media";
import { telegramAppAutomationService } from "./telegram-automation/app-automation";
import { twitterAppAutomationService } from "./twitter-automation/app-automation";

export type PromotionChannel =
  | "social"
  | "seo"
  | "advertising"
  | "twitter_automation"
  | "telegram_automation"
  | "discord_automation";

export interface PromotionConfig {
  channels: PromotionChannel[];
  social?: {
    platforms: SocialPlatform[];
    customMessage?: string;
    includeScreenshot?: boolean;
  };
  seo?: {
    generateMeta?: boolean;
    generateSchema?: boolean;
    submitToIndexNow?: boolean;
  };
  advertising?: {
    platform: AdPlatform;
    adAccountId: string;
    budget: number;
    budgetType: "daily" | "lifetime";
    objective: "awareness" | "traffic" | "engagement" | "app_promotion";
    duration?: number;
    targetLocations?: string[];
  };
  twitterAutomation?: {
    enabled: boolean;
    autoPost: boolean;
    autoReply: boolean;
    autoEngage: boolean;
    discovery: boolean;
    postIntervalMin: number;
    postIntervalMax: number;
    vibeStyle?: string;
    topics?: string[];
    agentCharacterId?: string;
  };
  telegramAutomation?: {
    useExisting?: boolean; // If true, just post using existing config
    enabled?: boolean;
    channelId?: string;
    groupId?: string;
    autoAnnounce?: boolean;
    autoReply?: boolean;
    announceIntervalMin?: number;
    announceIntervalMax?: number;
    vibeStyle?: string;
    agentCharacterId?: string;
  };
  discordAutomation?: {
    useExisting?: boolean; // If true, just post using existing config
    enabled?: boolean;
    guildId?: string;
    channelId?: string;
    autoAnnounce?: boolean;
    announceIntervalMin?: number;
    announceIntervalMax?: number;
    vibeStyle?: string;
    agentCharacterId?: string;
  };
}

export interface PromotionResult {
  appId: string;
  appName: string;
  appUrl: string;
  channels: {
    social?: {
      success: boolean;
      platforms: Array<{
        platform: SocialPlatform;
        success: boolean;
        postId?: string;
        postUrl?: string;
        error?: string;
      }>;
    };
    seo?: {
      success: boolean;
      requestId?: string;
      artifacts?: Array<{ type: string; data: Record<string, unknown> }>;
      error?: string;
    };
    advertising?: {
      success: boolean;
      campaignId?: string;
      campaignName?: string;
      error?: string;
    };
    twitterAutomation?: {
      success: boolean;
      enabled: boolean;
      initialTweetId?: string;
      initialTweetUrl?: string;
      error?: string;
    };
    telegramAutomation?: {
      success: boolean;
      enabled: boolean;
      initialMessageId?: string;
      error?: string;
    };
    discordAutomation?: {
      success: boolean;
      enabled: boolean;
      initialMessageId?: string;
      channelId?: string;
      error?: string;
    };
  };
  totalCreditsUsed: number;
  errors: string[];
}

export interface GeneratedPromotionalContent {
  headline: string;
  shortDescription: string;
  longDescription: string;
  callToAction: string;
  hashtags: string[];
  socialPosts: Partial<Record<SocialPlatform, string>>;
}

const PROMOTION_COSTS = {
  contentGeneration: AD_COPY_GENERATION_COST,
  socialPostBase: 0.001,
  seoBundle: 0.005,
  adCampaignSetup: 0,
  twitterAutomationSetup: TWITTER_AUTOMATION_SETUP_COST,
  twitterAutomationInitialTweet: TWITTER_POST_COST,
  telegramAutomationSetup: TELEGRAM_AUTOMATION_SETUP_COST,
  telegramAutomationInitialMessage: TELEGRAM_POST_COST,
  discordAutomationSetup: DISCORD_AUTOMATION_SETUP_COST,
  discordAutomationInitialMessage: DISCORD_POST_COST,
} as const;

class AppPromotionService {
  /**
   * Validate promotional content structure manually.
   * Bypasses Zod to avoid Turbopack bundling issues with Zod internals.
   */
  private validatePromotionalContent(data: unknown): GeneratedPromotionalContent {
    if (!data || typeof data !== "object") {
      throw new Error("Promotional content must be an object");
    }

    const obj = data as Record<string, unknown>;

    // Validate required string fields
    const requiredStrings = ["headline", "shortDescription", "longDescription", "callToAction"];
    for (const field of requiredStrings) {
      if (typeof obj[field] !== "string") {
        throw new Error(`Missing or invalid field: ${field}`);
      }
    }

    // Validate hashtags array
    if (!Array.isArray(obj.hashtags)) {
      throw new Error("hashtags must be an array");
    }
    for (const tag of obj.hashtags) {
      if (typeof tag !== "string") {
        throw new Error("All hashtags must be strings");
      }
    }

    // Validate socialPosts object
    if (!obj.socialPosts || typeof obj.socialPosts !== "object") {
      throw new Error("socialPosts must be an object");
    }
    const socialPosts = obj.socialPosts as Record<string, unknown>;
    for (const [platform, content] of Object.entries(socialPosts)) {
      if (typeof content !== "string") {
        throw new Error(`Social post for ${platform} must be a string`);
      }
    }

    return {
      headline: obj.headline as string,
      shortDescription: obj.shortDescription as string,
      longDescription: obj.longDescription as string,
      callToAction: obj.callToAction as string,
      hashtags: obj.hashtags as string[],
      socialPosts: obj.socialPosts as Partial<Record<SocialPlatform, string>>,
    };
  }

  async generatePromotionalContent(
    app: App,
    targetAudience?: string,
  ): Promise<GeneratedPromotionalContent> {
    const appDescription = app.description || `${app.name} - An app built on Eliza Cloud`;
    const appUrl = app.app_url;

    const prompt = `Generate promotional content for this app:

App Name: ${app.name}
Description: ${appDescription}
URL: ${appUrl}
${targetAudience ? `Target Audience: ${targetAudience}` : ""}

Generate the following in JSON format:
{
  "headline": "A catchy headline under 60 characters",
  "shortDescription": "A compelling 1-2 sentence description under 160 characters",
  "longDescription": "A detailed 2-3 paragraph description highlighting key features and benefits",
  "callToAction": "A short CTA phrase like 'Try it now' or 'Get started free'",
  "hashtags": ["relevant", "hashtags", "without", "the", "symbol"],
  "socialPosts": {
    "twitter": "A tweet under 280 characters with hashtags",
    "bluesky": "A Bluesky post under 300 characters",
    "linkedin": "A professional LinkedIn post under 700 characters",
    "facebook": "An engaging Facebook post under 500 characters",
    "discord": "A Discord announcement with formatting",
    "telegram": "A Telegram message with emoji"
  }
}

Return ONLY valid JSON, no markdown.`;

    const promoModel = "anthropic/claude-sonnet-4.6";
    // Note: When ANTHROPIC_COT_BUDGET is set, temperature is silently dropped by @ai-sdk/anthropic.
    // Promotional content generation is a background service that does not benefit from extended thinking.
    // Pass 0 as thinkingBudget to explicitly disable CoT for these internal service calls.
    const { text } = await generateText({
      model: getLanguageModel(promoModel),
      temperature: 0.7,
      prompt,
      // Note: CoT is explicitly disabled (budget=0) for promotional content generation
      // because it doesn't benefit from extended thinking and needs temperature control.
      ...mergeAnthropicCotProviderOptions(promoModel, process.env, 0),
    });

    // Parse and validate the AI response
    const extracted = text.trim();
    let jsonText = extracted;

    // Extract JSON from markdown code blocks if present
    const fenceMatch = extracted.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonText = fenceMatch[1].trim();
    }

    // Find JSON boundaries
    const jsonStart = jsonText.search(/[{[]/);
    const lastBrace = jsonText.lastIndexOf("}");
    const lastBracket = jsonText.lastIndexOf("]");
    const jsonEnd = Math.max(lastBrace, lastBracket);

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("No JSON found in AI response for promotional content");
    }

    const jsonString = jsonText.slice(jsonStart, jsonEnd + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonString);
    } catch (parseError) {
      logger.error("[AppPromotion] Failed to parse AI response JSON", {
        appId: app.id,
        error: parseError instanceof Error ? parseError.message : "Unknown error",
        jsonString: jsonString.substring(0, 500),
      });
      throw new Error("Failed to parse promotional content JSON");
    }

    // Validate structure manually (bypasses Zod to avoid Turbopack bundling issues)
    try {
      return this.validatePromotionalContent(parsed);
    } catch (validationError) {
      logger.error("[AppPromotion] Content validation failed", {
        appId: app.id,
        error: validationError instanceof Error ? validationError.message : "Unknown error",
      });
      throw new Error("Promotional content validation failed");
    }
  }

  async promoteApp(
    organizationId: string,
    userId: string,
    appId: string,
    config: PromotionConfig,
  ): Promise<PromotionResult> {
    logger.info("[AppPromotion] Starting app promotion", {
      appId,
      channels: config.channels,
    });

    const app = await appsService.getById(appId);
    if (!app) {
      throw new Error("App not found");
    }

    if (app.organization_id !== organizationId) {
      throw new Error("App does not belong to this organization");
    }

    const result: PromotionResult = {
      appId: app.id,
      appName: app.name,
      appUrl: app.app_url,
      channels: {},
      totalCreditsUsed: 0,
      errors: [],
    };

    // Generate promotional content if needed
    let promotionalContent: GeneratedPromotionalContent | undefined;
    if (config.channels.includes("social") || config.channels.includes("advertising")) {
      const contentDeduction = await creditsService.deductCredits({
        organizationId,
        amount: PROMOTION_COSTS.contentGeneration,
        description: `Generate promotional content for ${app.name}`,
        metadata: { appId, type: "content_generation" },
      });

      if (contentDeduction.success) {
        result.totalCreditsUsed += PROMOTION_COSTS.contentGeneration;
        try {
          promotionalContent = await this.generatePromotionalContent(app);
        } catch (error) {
          // Refund credits if content generation fails
          await creditsService.refundCredits({
            organizationId,
            amount: PROMOTION_COSTS.contentGeneration,
            description: `Refund: Content generation failed for ${app.name}`,
            metadata: { appId, type: "content_generation_refund" },
          });
          result.totalCreditsUsed -= PROMOTION_COSTS.contentGeneration;
          logger.error("[AppPromotion] Content generation failed, credits refunded", {
            appId,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          result.errors.push("Content generation failed - credits refunded");
        }
      }
    }

    // Execute each channel
    if (config.channels.includes("social") && config.social) {
      result.channels.social = await this.executeSocialPromotion(
        organizationId,
        userId,
        app,
        config.social,
        promotionalContent,
      );
      if (!result.channels.social.success) {
        result.errors.push("Social media promotion partially failed");
      }
      result.totalCreditsUsed += config.social.platforms.length * PROMOTION_COSTS.socialPostBase;
    }

    if (config.channels.includes("seo") && config.seo) {
      result.channels.seo = await this.executeSeoOptimization(
        organizationId,
        userId,
        app,
        config.seo,
      );
      if (!result.channels.seo.success) {
        result.errors.push(`SEO optimization failed: ${result.channels.seo.error}`);
      }
      result.totalCreditsUsed += PROMOTION_COSTS.seoBundle;
    }

    if (config.channels.includes("advertising") && config.advertising) {
      result.channels.advertising = await this.executeAdCampaign(
        organizationId,
        app,
        config.advertising,
        promotionalContent,
      );
      if (!result.channels.advertising.success) {
        result.errors.push(`Ad campaign creation failed: ${result.channels.advertising.error}`);
      }
    }

    if (config.channels.includes("twitter_automation") && config.twitterAutomation) {
      result.channels.twitterAutomation = await this.executeTwitterAutomation(
        organizationId,
        app,
        config.twitterAutomation,
      );
      if (!result.channels.twitterAutomation.success) {
        result.errors.push(`Twitter automation failed: ${result.channels.twitterAutomation.error}`);
      }
      result.totalCreditsUsed +=
        PROMOTION_COSTS.twitterAutomationSetup +
        (result.channels.twitterAutomation.initialTweetId
          ? PROMOTION_COSTS.twitterAutomationInitialTweet
          : 0);
    }

    if (config.channels.includes("telegram_automation") && config.telegramAutomation) {
      result.channels.telegramAutomation = await this.executeTelegramAutomation(
        organizationId,
        app,
        config.telegramAutomation,
      );
      if (!result.channels.telegramAutomation.success) {
        result.errors.push(
          `Telegram automation failed: ${result.channels.telegramAutomation.error}`,
        );
      }
      result.totalCreditsUsed +=
        PROMOTION_COSTS.telegramAutomationSetup +
        (result.channels.telegramAutomation.initialMessageId
          ? PROMOTION_COSTS.telegramAutomationInitialMessage
          : 0);
    }

    if (config.channels.includes("discord_automation") && config.discordAutomation) {
      result.channels.discordAutomation = await this.executeDiscordAutomation(
        organizationId,
        app,
        config.discordAutomation,
      );
      if (!result.channels.discordAutomation.success) {
        result.errors.push(`Discord automation failed: ${result.channels.discordAutomation.error}`);
      }
      result.totalCreditsUsed +=
        PROMOTION_COSTS.discordAutomationSetup +
        (result.channels.discordAutomation.initialMessageId
          ? PROMOTION_COSTS.discordAutomationInitialMessage
          : 0);
    }

    logger.info("[AppPromotion] Promotion complete", {
      appId,
      creditsUsed: result.totalCreditsUsed,
      errorCount: result.errors.length,
    });

    return result;
  }

  private async executeSocialPromotion(
    organizationId: string,
    userId: string,
    app: App,
    config: NonNullable<PromotionConfig["social"]>,
    content?: GeneratedPromotionalContent,
  ): Promise<NonNullable<PromotionResult["channels"]["social"]>> {
    const results: Array<{
      platform: SocialPlatform;
      success: boolean;
      postId?: string;
      postUrl?: string;
      error?: string;
    }> = [];

    for (const platform of config.platforms) {
      const postText =
        config.customMessage ||
        content?.socialPosts[platform] ||
        `Check out ${app.name}! ${app.description || ""} ${app.app_url}`;

      const postContent: PostContent = {
        text: postText,
      };

      const postResult = await socialMediaService.createPost({
        organizationId,
        userId,
        content: postContent,
        platforms: [platform],
      });

      const platformResult = postResult.results.find((r) => r.platform === platform);
      results.push({
        platform,
        success: platformResult?.success ?? false,
        postId: platformResult?.postId,
        postUrl: platformResult?.postUrl,
        error: platformResult?.error,
      });
    }

    return {
      success: results.some((r) => r.success),
      platforms: results,
    };
  }

  private async executeSeoOptimization(
    organizationId: string,
    userId: string,
    app: App,
    config: NonNullable<PromotionConfig["seo"]>,
  ): Promise<NonNullable<PromotionResult["channels"]["seo"]>> {
    if (!app.app_url) {
      return {
        success: false,
        error: "App URL is required for SEO optimization",
      };
    }

    const seoType = this.determineSeoType(config);
    const result = await seoService.createRequest({
      organizationId,
      userId,
      appId: app.id,
      type: seoType,
      pageUrl: app.app_url,
      keywords: [app.name, "ai app", "eliza cloud"],
      promptContext: `App: ${app.name}. ${app.description || ""}`,
    });

    return {
      success: result.request.status === "completed",
      requestId: result.request.id,
      artifacts: result.artifacts.map((a) => ({
        type: a.type,
        data: a.data as Record<string, unknown>,
      })),
      error: result.request.status === "failed" ? "SEO request failed" : undefined,
    };
  }

  private determineSeoType(
    config: NonNullable<PromotionConfig["seo"]>,
  ): CreateSeoRequestParams["type"] {
    if (config.generateMeta && config.generateSchema) return "publish_bundle";
    if (config.generateMeta) return "meta_generate";
    if (config.generateSchema) return "schema_generate";
    if (config.submitToIndexNow) return "index_now";
    return "health_check";
  }

  private async executeAdCampaign(
    organizationId: string,
    app: App,
    config: NonNullable<PromotionConfig["advertising"]>,
    content?: GeneratedPromotionalContent,
  ): Promise<NonNullable<PromotionResult["channels"]["advertising"]>> {
    const startDate = new Date();
    const endDate = config.duration
      ? new Date(startDate.getTime() + config.duration * 24 * 60 * 60 * 1000)
      : undefined;

    const campaign = await advertisingService.createCampaign({
      organizationId,
      adAccountId: config.adAccountId,
      name: `${app.name} - Promotion Campaign`,
      objective: config.objective,
      budgetType: config.budgetType,
      budgetAmount: config.budget,
      startDate,
      endDate,
      appId: app.id,
      targeting: config.targetLocations?.length ? { locations: config.targetLocations } : undefined,
    });

    if (content) {
      await this.createDefaultCreative(organizationId, campaign.id, app, content);
    }

    return {
      success: true,
      campaignId: campaign.id,
      campaignName: campaign.name,
    };
  }

  private async createDefaultCreative(
    organizationId: string,
    campaignId: string,
    app: App,
    content: GeneratedPromotionalContent,
  ): Promise<void> {
    await advertisingService
      .createCreative(organizationId, {
        campaignId,
        name: `${app.name} - Default Creative`,
        type: "image",
        headline: content.headline,
        primaryText: content.longDescription.substring(0, 500),
        description: content.shortDescription,
        callToAction: "learn_more",
        destinationUrl: app.app_url,
        media: [],
      })
      .catch((err) => {
        logger.warn("[AppPromotion] Failed to create default creative", {
          campaignId,
          error: extractErrorMessage(err),
        });
      });
  }

  /**
   * Execute Twitter/X automation setup for an app
   * This enables the AI agent to autonomously promote the app
   */
  private async executeTwitterAutomation(
    organizationId: string,
    app: App,
    config: NonNullable<PromotionConfig["twitterAutomation"]>,
  ): Promise<NonNullable<PromotionResult["channels"]["twitterAutomation"]>> {
    try {
      // Enable automation with the provided config
      await twitterAppAutomationService.enableAutomation(organizationId, app.id, {
        enabled: config.enabled,
        autoPost: config.autoPost,
        autoReply: config.autoReply,
        autoEngage: config.autoEngage,
        discovery: config.discovery,
        postIntervalMin: config.postIntervalMin,
        postIntervalMax: config.postIntervalMax,
        vibeStyle: config.vibeStyle,
        topics: config.topics,
        agentCharacterId: config.agentCharacterId,
      });

      // Post an initial announcement tweet if autoPost is enabled
      let initialTweetId: string | undefined;
      let initialTweetUrl: string | undefined;

      if (config.autoPost) {
        const tweetResult = await twitterAppAutomationService.postAppTweet(organizationId, app.id);

        if (tweetResult.success) {
          initialTweetId = tweetResult.tweetId;
          initialTweetUrl = tweetResult.tweetUrl;
        }
      }

      logger.info("[AppPromotion] Twitter automation enabled", {
        appId: app.id,
        organizationId,
        initialTweetId,
      });

      return {
        success: true,
        enabled: true,
        initialTweetId,
        initialTweetUrl,
      };
    } catch (error) {
      logger.error("[AppPromotion] Twitter automation failed", {
        appId: app.id,
        error: extractErrorMessage(error),
      });

      return {
        success: false,
        enabled: false,
        error: extractErrorMessage(error),
      };
    }
  }

  /**
   * Execute Telegram automation setup for an app
   * This enables the AI agent to autonomously promote the app on Telegram
   */
  private async executeTelegramAutomation(
    organizationId: string,
    app: App,
    config: NonNullable<PromotionConfig["telegramAutomation"]>,
  ): Promise<NonNullable<PromotionResult["channels"]["telegramAutomation"]>> {
    try {
      // If useExisting is true, just post using existing automation config
      if (config.useExisting) {
        logger.info("[AppPromotion] Using existing Telegram automation, posting only", {
          appId: app.id,
          organizationId,
        });

        const postResult = await telegramAppAutomationService.postAnnouncement(
          organizationId,
          app.id,
        );

        return {
          success: postResult.success,
          enabled: true,
          initialMessageId: postResult.messageId?.toString(),
          error: postResult.error,
        };
      }

      // Use channelId for announcements, or groupId as fallback
      const chatId = config.channelId || config.groupId;

      // Validate that we have the required config
      if (!chatId) {
        return {
          success: false,
          enabled: false,
          error: "Telegram channel or group must be selected",
        };
      }

      // Enable automation with the provided config
      await telegramAppAutomationService.enableAutomation(organizationId, app.id, {
        enabled: config.enabled ?? true,
        channelId: config.channelId,
        groupId: config.groupId,
        autoAnnounce: config.autoAnnounce ?? true,
        autoReply: config.autoReply,
        announceIntervalMin: config.announceIntervalMin ?? 120,
        announceIntervalMax: config.announceIntervalMax ?? 240,
        vibeStyle: config.vibeStyle,
        agentCharacterId: config.agentCharacterId,
      });

      // Post an initial announcement if autoAnnounce is enabled
      let initialMessageId: string | undefined;

      if (config.autoAnnounce !== false) {
        const postResult = await telegramAppAutomationService.postAnnouncement(
          organizationId,
          app.id,
        );

        if (postResult.success && postResult.messageId) {
          initialMessageId = postResult.messageId.toString();
        }
      }

      logger.info("[AppPromotion] Telegram automation enabled", {
        appId: app.id,
        organizationId,
        channelId: config.channelId,
        groupId: config.groupId,
        initialMessageId,
      });

      return {
        success: true,
        enabled: true,
        initialMessageId,
      };
    } catch (error) {
      logger.error("[AppPromotion] Telegram automation failed", {
        appId: app.id,
        error: extractErrorMessage(error),
      });

      return {
        success: false,
        enabled: false,
        error: extractErrorMessage(error),
      };
    }
  }

  /**
   * Execute Discord automation setup for an app
   * This enables the AI agent to autonomously promote the app on Discord
   */
  private async executeDiscordAutomation(
    organizationId: string,
    app: App,
    config: NonNullable<PromotionConfig["discordAutomation"]>,
  ): Promise<NonNullable<PromotionResult["channels"]["discordAutomation"]>> {
    try {
      // If useExisting is true, just post using existing automation config
      if (config.useExisting) {
        logger.info("[AppPromotion] Using existing Discord automation, posting only", {
          appId: app.id,
          organizationId,
        });

        const postResult = await discordAppAutomationService.postAnnouncement(
          organizationId,
          app.id,
        );

        return {
          success: postResult.success,
          enabled: true,
          initialMessageId: postResult.messageId,
          channelId: postResult.channelId,
          error: postResult.error,
        };
      }

      // Validate that we have the required config for new setup
      if (!config.guildId || !config.channelId) {
        return {
          success: false,
          enabled: false,
          error: "Discord server and channel must be selected",
        };
      }

      // Enable automation with the provided config
      await discordAppAutomationService.enableAutomation(organizationId, app.id, {
        enabled: config.enabled ?? true,
        guildId: config.guildId,
        channelId: config.channelId,
        autoAnnounce: config.autoAnnounce ?? true,
        announceIntervalMin: config.announceIntervalMin ?? 120,
        announceIntervalMax: config.announceIntervalMax ?? 240,
        vibeStyle: config.vibeStyle,
        agentCharacterId: config.agentCharacterId,
      });

      // Post an initial announcement if autoAnnounce is enabled
      let initialMessageId: string | undefined;
      let channelId: string | undefined;

      if (config.autoAnnounce !== false) {
        const postResult = await discordAppAutomationService.postAnnouncement(
          organizationId,
          app.id,
        );

        if (postResult.success) {
          initialMessageId = postResult.messageId;
          channelId = postResult.channelId;
        }
      }

      logger.info("[AppPromotion] Discord automation enabled", {
        appId: app.id,
        organizationId,
        guildId: config.guildId,
        channelId: config.channelId,
        initialMessageId,
      });

      return {
        success: true,
        enabled: true,
        initialMessageId,
        channelId,
      };
    } catch (error) {
      logger.error("[AppPromotion] Discord automation failed", {
        appId: app.id,
        error: extractErrorMessage(error),
      });

      return {
        success: false,
        enabled: false,
        error: extractErrorMessage(error),
      };
    }
  }

  /**
   * Get promotion suggestions for an app
   */
  async getPromotionSuggestions(
    organizationId: string,
    appId: string,
  ): Promise<{
    recommendedChannels: PromotionChannel[];
    estimatedBudget: { min: number; max: number };
    suggestedPlatforms: SocialPlatform[];
    tips: string[];
    twitterAutomationStatus?: {
      connected: boolean;
      enabled: boolean;
    };
  }> {
    const app = await appsService.getById(appId);
    if (!app || app.organization_id !== organizationId) {
      throw new Error("App not found");
    }

    // Check Twitter automation status
    let twitterAutomationStatus: { connected: boolean; enabled: boolean } | undefined;
    try {
      const status = await twitterAppAutomationService.getAutomationStatus(organizationId, appId);
      twitterAutomationStatus = {
        connected: status.twitterConnected,
        enabled: status.enabled,
      };
    } catch {
      twitterAutomationStatus = { connected: false, enabled: false };
    }

    const recommendedChannels: PromotionChannel[] = ["social"];
    if (twitterAutomationStatus.connected) {
      recommendedChannels.push("twitter_automation");
    }

    const tips = [
      "Start with social media announcements to build initial awareness",
      "Generate custom images to make your posts stand out",
      "Enable automation for consistent 24/7 engagement",
    ];

    if (twitterAutomationStatus.connected && !twitterAutomationStatus.enabled) {
      tips.unshift("🚀 Enable Twitter Automation for 24/7 AI-powered vibe marketing!");
    }

    return {
      recommendedChannels,
      estimatedBudget: { min: 0, max: 0 },
      suggestedPlatforms: ["twitter", "bluesky", "linkedin", "discord"],
      tips,
      twitterAutomationStatus,
    };
  }

  async getPromotionHistory(
    organizationId: string,
    appId: string,
  ): Promise<{
    totalCampaigns: number;
    recentActivity: Array<{
      type: "advertising";
      date: Date;
      description: string;
    }>;
  }> {
    const app = await appsService.getById(appId);
    if (!app || app.organization_id !== organizationId) {
      throw new Error("App not found");
    }

    const campaigns = await advertisingService.listCampaigns(organizationId, {
      appId,
    });

    return {
      totalCampaigns: campaigns.length,
      recentActivity: campaigns.slice(0, 10).map((c) => ({
        type: "advertising" as const,
        date: c.created_at,
        description: `Created campaign: ${c.name}`,
      })),
    };
  }
}

export const appPromotionService = new AppPromotionService();
