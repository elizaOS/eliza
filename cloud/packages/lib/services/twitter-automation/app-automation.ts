import { generateText } from "ai";
import { TwitterApi } from "twitter-api-v2";
import { type App, appsRepository } from "@/db/repositories";
import { TWITTER_POST_COST } from "@/lib/promotion-pricing";
import { mergeAnthropicCotProviderOptions } from "@/lib/providers/anthropic-thinking";
import { getLanguageModel } from "@/lib/providers/language-model";
// Note: When ANTHROPIC_COT_BUDGET is set and model is Anthropic, temperature is silently dropped
// per @ai-sdk/anthropic behavior. This service uses temperature for creative tweet generation.
import {
  buildCharacterSystemPrompt,
  getCharacterPromptContext,
} from "@/lib/services/character-prompt-helper";
import { creditsService } from "@/lib/services/credits";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";

const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET_KEY = process.env.TWITTER_API_SECRET_KEY;
const TWITTER_API_TIMEOUT_MS = 25_000;

export interface TwitterAutomationConfig {
  enabled: boolean;
  autoPost: boolean;
  autoReply: boolean;
  autoEngage: boolean;
  discovery: boolean;
  postIntervalMin: number;
  postIntervalMax: number;
  vibeStyle?: string;
  topics?: string[];
  lastPostAt?: string;
  totalPosts?: number;
  agentCharacterId?: string;
}

export interface GeneratedTweet {
  text: string;
  type: "promotional" | "engagement" | "educational" | "announcement";
}

class TwitterAppAutomationService {
  private async getAppForOrg(organizationId: string, appId: string): Promise<App> {
    const app = await appsRepository.findById(appId);
    if (!app || app.organization_id !== organizationId) {
      throw new Error("App not found");
    }
    return app;
  }

  async enableAutomation(
    organizationId: string,
    appId: string,
    config: Partial<TwitterAutomationConfig>,
  ): Promise<App> {
    const app = await this.getAppForOrg(organizationId, appId);

    const hasTwitter = await this.isTwitterConnected(organizationId);
    if (!hasTwitter) {
      throw new Error("Twitter account must be connected before enabling automation");
    }

    const currentConfig = (app.twitter_automation || {}) as TwitterAutomationConfig;
    const updatedConfig: TwitterAutomationConfig = {
      enabled: true,
      autoPost: config.autoPost ?? currentConfig.autoPost ?? true,
      autoReply: config.autoReply ?? currentConfig.autoReply ?? true,
      autoEngage: config.autoEngage ?? currentConfig.autoEngage ?? false,
      discovery: config.discovery ?? currentConfig.discovery ?? false,
      postIntervalMin: config.postIntervalMin ?? currentConfig.postIntervalMin ?? 90,
      postIntervalMax: config.postIntervalMax ?? currentConfig.postIntervalMax ?? 150,
      vibeStyle: config.vibeStyle ?? currentConfig.vibeStyle,
      topics: config.topics ?? currentConfig.topics,
      totalPosts: currentConfig.totalPosts ?? 0,
      agentCharacterId: config.agentCharacterId ?? currentConfig.agentCharacterId,
    };

    const updated = await appsRepository.update(appId, {
      twitter_automation: updatedConfig,
    });

    if (!updated) {
      throw new Error("Failed to update app");
    }

    logger.info("[TwitterAppAutomation] Enabled automation for app", {
      appId,
      organizationId,
      config: updatedConfig,
    });

    return updated;
  }

  async disableAutomation(organizationId: string, appId: string): Promise<App> {
    const app = await this.getAppForOrg(organizationId, appId);

    const currentConfig = (app.twitter_automation || {}) as TwitterAutomationConfig;
    const updatedConfig: TwitterAutomationConfig = {
      ...currentConfig,
      enabled: false,
    };

    const updated = await appsRepository.update(appId, {
      twitter_automation: updatedConfig,
    });

    if (!updated) {
      throw new Error("Failed to update app");
    }

    logger.info("[TwitterAppAutomation] Disabled automation for app", {
      appId,
      organizationId,
    });

    return updated;
  }

  async getAutomationStatus(
    organizationId: string,
    appId: string,
  ): Promise<{
    enabled: boolean;
    config: TwitterAutomationConfig | null;
    twitterConnected: boolean;
    lastPost?: string;
    totalPosts: number;
  }> {
    const app = await this.getAppForOrg(organizationId, appId);

    const config = app.twitter_automation as TwitterAutomationConfig | null;
    const twitterConnected = await this.isTwitterConnected(organizationId);

    return {
      enabled: config?.enabled ?? false,
      config,
      twitterConnected,
      lastPost: config?.lastPostAt,
      totalPosts: config?.totalPosts ?? 0,
    };
  }

  async generateAppTweet(
    organizationId: string,
    app: App,
    type: "promotional" | "engagement" | "educational" | "announcement" = "promotional",
  ): Promise<GeneratedTweet> {
    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: TWITTER_POST_COST,
      description: `Twitter AI tweet: ${app.name}`,
      metadata: { appId: app.id, type: "twitter_tweet" },
    });

    if (!deduction.success) {
      throw new Error(
        `Insufficient credits for AI generation. Required: $${TWITTER_POST_COST.toFixed(4)}`,
      );
    }

    const config = app.twitter_automation as TwitterAutomationConfig | null;
    const vibeStyle = config?.vibeStyle ?? "professional yet approachable";
    const topics = config?.topics?.join(", ") ?? "";

    let characterPrompt = "";
    if (config?.agentCharacterId) {
      const characterContext = await getCharacterPromptContext(config.agentCharacterId);
      if (characterContext) {
        characterPrompt = buildCharacterSystemPrompt(characterContext);
        logger.info("[TwitterAppAutomation] Using character voice", {
          appId: app.id,
          characterId: config.agentCharacterId,
          characterName: characterContext.name,
        });
      } else {
        logger.warn("[TwitterAppAutomation] Character not found, using default", {
          appId: app.id,
          characterId: config.agentCharacterId,
        });
      }
    } else {
      logger.info("[TwitterAppAutomation] No character selected, using default voice", {
        appId: app.id,
      });
    }

    const prompt = characterPrompt
      ? `${characterPrompt}

CRITICAL INSTRUCTION: You MUST tweet as YOUR character would - not as a generic marketer.

Task: Promote this app in a tweet (max 280 chars)
App: ${app.name}
Description: ${app.description ?? "An AI-powered app built on Eliza Cloud"}
URL: ${app.app_url}
${topics ? `YOUR focus topics: ${topics}` : ""}

Tweet Type: ${type}

RULES:
1. Write EXACTLY how YOUR character would promote this
2. Use YOUR personality, YOUR interests, YOUR speaking patterns  
3. Connect the app to YOUR topics/expertise naturally
4. Include 1-2 hashtags that YOUR character would use
5. Include the app URL naturally
6. Be AUTHENTICALLY you - not corporate, not generic

${type === "promotional" ? "Show why YOUR character finds this app interesting" : ""}
${type === "engagement" ? "Ask a question YOUR character would ask about this" : ""}
${type === "educational" ? "Share insight from YOUR character's perspective" : ""}
${type === "announcement" ? "Announce it the way YOUR character would" : ""}

Tweet NOW in YOUR authentic voice:`
      : `Generate a single tweet promoting this app. Keep it under 280 characters.

App Name: ${app.name}
Description: ${app.description ?? "An AI-powered app built on Eliza Cloud"}
URL: ${app.app_url}
${topics ? `Topics to mention: ${topics}` : ""}

Tweet Type: ${type}
- promotional: Highlight features and encourage trying the app
- engagement: Ask a question or start a conversation related to the app
- educational: Share a tip or insight related to what the app does
- announcement: Announce something exciting about the app

Vibe/Style: ${vibeStyle}

Requirements:
- Include 1-2 relevant hashtags
- Include the app URL naturally
- Be authentic and engaging, not salesy
- Match the vibe style specified

Return ONLY the tweet text, nothing else.`;

    try {
      const twModel = "anthropic/claude-sonnet-4.6";
      // Note: Explicitly disable extended thinking (pass 0) for tweet generation.
      // This is a background service that requires temperature control for creative output,
      // and enabling CoT would silently drop temperature per @ai-sdk/anthropic behavior.
      // Temperature 0.8 for varied, creative tweet content.
      const { text } = await generateText({
        model: getLanguageModel(twModel),
        ...mergeAnthropicCotProviderOptions(twModel, process.env, 0),
        temperature: 0.8,
        prompt,
      });

      return {
        text: text.trim().slice(0, 280),
        type,
      };
    } catch (error) {
      await creditsService.refundCredits({
        organizationId,
        amount: TWITTER_POST_COST,
        description: "Refund for failed Twitter AI generation",
        metadata: { appId: app.id, type: "twitter_tweet_refund" },
      });
      throw error;
    }
  }

  async postAppTweet(
    organizationId: string,
    appId: string,
    tweetText?: string,
  ): Promise<{
    success: boolean;
    tweetId?: string;
    tweetUrl?: string;
    error?: string;
  }> {
    const app = await appsRepository.findById(appId);
    if (!app || app.organization_id !== organizationId) {
      return { success: false, error: "App not found" };
    }

    const client = await this.getTwitterClient(organizationId);
    if (!client) {
      return { success: false, error: "Twitter not connected" };
    }

    let text = tweetText;
    if (!text) {
      const generated = await this.generateAppTweet(organizationId, app, "promotional");
      text = generated.text;
    }

    let tweetResult;
    try {
      tweetResult = await Promise.race([
        client.v2.tweet(text),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Twitter API timeout")), TWITTER_API_TIMEOUT_MS),
        ),
      ]);
    } catch (error) {
      logger.error("[TwitterAppAutomation] Failed to post tweet", {
        appId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to post to Twitter",
      };
    }

    const config = (app.twitter_automation || {}) as TwitterAutomationConfig;
    await appsRepository.update(appId, {
      twitter_automation: {
        ...config,
        lastPostAt: new Date().toISOString(),
        totalPosts: (config.totalPosts ?? 0) + 1,
      },
    });

    logger.info("[TwitterAppAutomation] Posted tweet for app", {
      appId,
      tweetId: tweetResult.data.id,
    });

    return {
      success: true,
      tweetId: tweetResult.data.id,
      tweetUrl: `https://twitter.com/i/web/status/${tweetResult.data.id}`,
    };
  }

  private async isTwitterConnected(organizationId: string): Promise<boolean> {
    const accessToken = await secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN");
    return !!accessToken;
  }

  private async getTwitterClient(organizationId: string): Promise<TwitterApi | null> {
    const [accessToken, accessTokenSecret] = await Promise.all([
      secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN"),
      secretsService.get(organizationId, "TWITTER_ACCESS_TOKEN_SECRET"),
    ]);

    if (!accessToken || !accessTokenSecret) {
      return null;
    }

    if (!TWITTER_API_KEY || !TWITTER_API_SECRET_KEY) {
      throw new Error("Twitter API credentials not configured");
    }

    return new TwitterApi({
      appKey: TWITTER_API_KEY,
      appSecret: TWITTER_API_SECRET_KEY,
      accessToken,
      accessSecret: accessTokenSecret,
    });
  }

  async getAppsWithActiveAutomation(): Promise<App[]> {
    const allApps = await appsRepository.listAll({ isActive: true });
    return allApps.filter((app) => {
      const config = app.twitter_automation as TwitterAutomationConfig | null;
      return config?.enabled === true;
    });
  }
}

export const twitterAppAutomationService = new TwitterAppAutomationService();
