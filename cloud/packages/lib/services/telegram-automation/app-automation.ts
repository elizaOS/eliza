import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { Telegraf } from "telegraf";
import { appsRepository } from "@/db/repositories/apps";
import type { App } from "@/db/schemas/apps";
import { TELEGRAM_POST_COST } from "@/lib/promotion-pricing";
import {
  getTelegramConfigWithDefaults,
  TELEGRAM_AUTOMATION_DEFAULTS,
} from "@/lib/services/automation-constants";
import {
  buildCharacterSystemPrompt,
  getCharacterPromptContext,
} from "@/lib/services/character-prompt-helper";
import { creditsService } from "@/lib/services/credits";
import { logger } from "@/lib/utils/logger";
import {
  createInlineKeyboard,
  splitMessage,
  TELEGRAM_RATE_LIMITS,
} from "@/lib/utils/telegram-helpers";
import { telegramAutomationService } from "./index";

export interface TelegramAutomationConfig {
  enabled?: boolean;
  botUsername?: string;
  channelId?: string;
  groupId?: string;
  autoReply?: boolean;
  autoAnnounce?: boolean;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  welcomeMessage?: string;
  vibeStyle?: string;
  agentCharacterId?: string; // Character used for automation voice
  lastAnnouncementAt?: string; // ISO timestamp of last announcement
  totalMessages?: number; // Total messages sent
}

export interface TelegramAutomationStatus {
  enabled: boolean;
  botConnected: boolean;
  botUsername?: string;
  channelId?: string;
  groupId?: string;
  autoReply: boolean;
  autoAnnounce: boolean;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  lastAnnouncementAt?: string;
  totalMessages: number;
  agentCharacterId?: string; // Character voice for posts
}

export interface PostResult {
  success: boolean;
  messageId?: number;
  chatId?: string | number;
  error?: string;
}

class TelegramAppAutomationService {
  /**
   * Get app for organization, checking ownership.
   */
  private async getAppForOrg(organizationId: string, appId: string): Promise<App> {
    const app = await appsRepository.findById(appId);
    if (!app || app.organization_id !== organizationId) {
      throw new Error("App not found");
    }
    return app;
  }

  /**
   * Enable or update automation for an app.
   */
  async enableAutomation(
    organizationId: string,
    appId: string,
    config: TelegramAutomationConfig,
  ): Promise<App> {
    const app = await this.getAppForOrg(organizationId, appId);

    const isConnected = await telegramAutomationService.isConfigured(organizationId);
    if (!isConnected) {
      throw new Error("Telegram bot not connected. Connect a bot in Settings first.");
    }

    const currentConfig = getTelegramConfigWithDefaults(
      app.telegram_automation as Record<string, unknown> | null,
    );

    const updatedConfig = {
      ...currentConfig,
      ...config,
      enabled: config.enabled ?? true,
    };

    const updatedApp = await appsRepository.update(appId, {
      telegram_automation: updatedConfig,
    });
    if (!updatedApp) {
      throw new Error("Failed to update Telegram automation settings");
    }

    logger.info("[TelegramAppAutomation] Automation enabled", {
      appId,
      organizationId,
      config: updatedConfig,
    });

    return updatedApp;
  }

  /**
   * Disable automation for an app.
   */
  async disableAutomation(organizationId: string, appId: string): Promise<App> {
    const app = await this.getAppForOrg(organizationId, appId);

    const currentConfig = getTelegramConfigWithDefaults(
      app.telegram_automation as Record<string, unknown> | null,
    );

    const updatedApp = await appsRepository.update(appId, {
      telegram_automation: {
        ...currentConfig,
        enabled: false,
      },
    });
    if (!updatedApp) {
      throw new Error("Failed to disable Telegram automation");
    }

    logger.info("[TelegramAppAutomation] Automation disabled", {
      appId,
      organizationId,
    });

    return updatedApp;
  }

  /**
   * Get automation status for an app.
   */
  async getAutomationStatus(
    organizationId: string,
    appId: string,
  ): Promise<TelegramAutomationStatus> {
    const app = await this.getAppForOrg(organizationId, appId);
    const connectionStatus = await telegramAutomationService.getConnectionStatus(organizationId);

    const config = (app.telegram_automation || {
      enabled: false,
      autoReply: true,
      autoAnnounce: false,
      announceIntervalMin: 120,
      announceIntervalMax: 240,
    }) as TelegramAutomationConfig;

    return {
      enabled: config.enabled ?? false,
      botConnected: connectionStatus.connected,
      botUsername: connectionStatus.botUsername || config.botUsername,
      channelId: config.channelId,
      groupId: config.groupId,
      autoReply: config.autoReply ?? true,
      autoAnnounce: config.autoAnnounce ?? false,
      announceIntervalMin: config.announceIntervalMin ?? 120,
      announceIntervalMax: config.announceIntervalMax ?? 240,
      lastAnnouncementAt: config.lastAnnouncementAt,
      totalMessages: config.totalMessages ?? 0,
      agentCharacterId: config.agentCharacterId,
    };
  }

  async generateAnnouncement(organizationId: string, app: App): Promise<string> {
    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: TELEGRAM_POST_COST,
      description: `Telegram AI announcement: ${app.name}`,
      metadata: { appId: app.id, type: "telegram_announcement" },
    });

    if (!deduction.success) {
      throw new Error(
        `Insufficient credits for AI generation. Required: $${TELEGRAM_POST_COST.toFixed(4)}`,
      );
    }

    const config = app.telegram_automation as TelegramAutomationConfig;
    const vibeStyle = config?.vibeStyle || "professional and engaging";

    let characterPrompt = "";
    if (config?.agentCharacterId) {
      const characterContext = await getCharacterPromptContext(config.agentCharacterId);
      if (characterContext) {
        characterPrompt = buildCharacterSystemPrompt(characterContext);
        logger.info("[TelegramAppAutomation] Using character voice", {
          appId: app.id,
          characterId: config.agentCharacterId,
          characterName: characterContext.name,
        });
      } else {
        logger.warn("[TelegramAppAutomation] Character not found, using default", {
          appId: app.id,
          characterId: config.agentCharacterId,
        });
      }
    } else {
      logger.info("[TelegramAppAutomation] No character selected, using default voice", {
        appId: app.id,
      });
    }

    const systemPrompt = characterPrompt
      ? `${characterPrompt}

CRITICAL: You MUST write as YOUR character, not as a generic AI.

Task: Create a Telegram announcement for "${app.name}"
App: ${app.description || "A great application"}
URL: ${app.website_url || app.app_url}

Requirements:
- Write EXACTLY how YOUR character would announce this
- Use YOUR personality, YOUR topics, YOUR way of speaking
- Max 500 characters
- Emojis only if they fit YOUR style
- Stay 100% in character - be authentic to who YOU are

Write it NOW in YOUR voice:`
      : `You are creating a Telegram announcement for an app called "${app.name}".
The app is: ${app.description || "A great application"}
Website: ${app.website_url || app.app_url}

Write in a ${vibeStyle} style. Keep it concise and engaging.
Use appropriate emojis sparingly. Do not use hashtags excessively.
Maximum 500 characters.`;

    try {
      const result = await generateText({
        model: openai("gpt-5-mini"),
        system: systemPrompt,
        prompt:
          "Create a compelling announcement about this app that would engage a Telegram community. Focus on what makes it unique and valuable.",
        maxOutputTokens: 200,
      });

      return result.text;
    } catch (error) {
      await creditsService.refundCredits({
        organizationId,
        amount: TELEGRAM_POST_COST,
        description: "Refund for failed Telegram AI generation",
        metadata: { appId: app.id, type: "telegram_announcement_refund" },
      });
      throw error;
    }
  }

  async generateReply(
    organizationId: string,
    app: App,
    userMessage: string,
    userName?: string,
  ): Promise<string> {
    const deduction = await creditsService.deductCredits({
      organizationId,
      amount: TELEGRAM_POST_COST,
      description: `Telegram AI reply: ${app.name}`,
      metadata: { appId: app.id, type: "telegram_reply" },
    });

    if (!deduction.success) {
      throw new Error(
        `Insufficient credits for AI generation. Required: $${TELEGRAM_POST_COST.toFixed(4)}`,
      );
    }

    const config = app.telegram_automation as TelegramAutomationConfig;
    const vibeStyle = config?.vibeStyle || "helpful and friendly";

    let characterPrompt = "";
    if (config?.agentCharacterId) {
      const characterContext = await getCharacterPromptContext(config.agentCharacterId);
      if (characterContext) {
        characterPrompt = buildCharacterSystemPrompt(characterContext);
      }
    }

    const systemPrompt = characterPrompt
      ? `${characterPrompt}

CRITICAL: Reply as YOUR character would - stay 100% in character.

Context: You're answering questions about "${app.name}"
App: ${app.description || "A helpful application"}
URL: ${app.website_url || app.app_url}

Requirements:
- Answer in YOUR voice - how would YOUR character explain this?
- Use YOUR personality and speaking style
- Max 300 characters
- Stay authentic to YOUR character
- If off-topic, redirect in YOUR way

Respond NOW as YOUR character:`
      : `You are an AI assistant for "${app.name}" on Telegram.
App description: ${app.description || "A helpful application"}
Website: ${app.website_url || app.app_url}

Respond in a ${vibeStyle} style. Be helpful and concise.
If asked about features not related to the app, politely redirect to the app's purpose.
Maximum 300 characters.`;

    try {
      const result = await generateText({
        model: openai("gpt-5-mini"),
        system: systemPrompt,
        prompt: userName
          ? `User ${userName} says: "${userMessage}"`
          : `User says: "${userMessage}"`,
        maxOutputTokens: 150,
      });

      return result.text;
    } catch (error) {
      await creditsService.refundCredits({
        organizationId,
        amount: TELEGRAM_POST_COST,
        description: "Refund for failed Telegram AI reply",
        metadata: { appId: app.id, type: "telegram_reply_refund" },
      });
      throw error;
    }
  }

  /**
   * Get the best promotional image for Telegram (prefer square for better display)
   */
  private getPromotionalImage(app: App): string | undefined {
    const assets = app.promotional_assets;
    if (!assets || assets.length === 0) return undefined;

    // Prefer square images for Telegram (instagram_square)
    const preferred = assets.find(
      (a) =>
        a.url &&
        (a.size.width === a.size.height || // Square
          a.type === "banner"),
    );
    if (preferred?.url) return preferred.url;

    // Fallback to any available image
    const anyImage = assets.find((a) => a.url);
    return anyImage?.url;
  }

  /**
   * Post an announcement to a channel or group.
   * Sends promotional image if available.
   * @param chatIdOverride - Optional override for target chat (channelId or groupId)
   */
  async postAnnouncement(
    organizationId: string,
    appId: string,
    text?: string,
    chatIdOverride?: string,
  ): Promise<PostResult> {
    const app = await this.getAppForOrg(organizationId, appId);
    const config = app.telegram_automation;

    if (!config?.enabled) {
      return { success: false, error: "Automation not enabled for this app" };
    }

    const chatId = chatIdOverride || config.channelId || config.groupId;
    if (!chatId) {
      return { success: false, error: "No channel or group configured" };
    }

    const messageText = text || (await this.generateAnnouncement(organizationId, app));

    const botToken = await telegramAutomationService.getBotToken(organizationId);
    if (!botToken) {
      return { success: false, error: "Bot not connected" };
    }

    const bot = new Telegraf(botToken);
    const buttonUrl = app.website_url || app.app_url;

    // Get promotional image if available
    const promotionalImageUrl = this.getPromotionalImage(app);

    let lastMessageId: number | undefined;
    let lastError: string | undefined;

    try {
      // If we have a promotional image, send it as a photo with caption
      if (promotionalImageUrl) {
        // Telegram photo captions are limited to 1024 characters
        const caption =
          messageText.length > 1024 ? messageText.substring(0, 1021) + "..." : messageText;

        const replyMarkup = buttonUrl
          ? createInlineKeyboard([{ text: "🚀 Try It Now", url: buttonUrl }])
          : undefined;

        const result = await Promise.race([
          bot.telegram.sendPhoto(chatId, promotionalImageUrl, {
            caption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Telegram API timeout")), 25_000),
          ),
        ]);

        lastMessageId = result.message_id;

        logger.info("[TelegramAppAutomation] Photo announcement posted", {
          appId,
          chatId,
          messageId: lastMessageId,
          imageUrl: promotionalImageUrl,
        });
      } else {
        // No image - send text message as before
        const chunks = splitMessage(messageText, TELEGRAM_RATE_LIMITS.MAX_MESSAGE_LENGTH);

        for (const chunk of chunks) {
          const isLastChunk = chunk === chunks[chunks.length - 1];
          const replyMarkup =
            isLastChunk && buttonUrl
              ? createInlineKeyboard([{ text: "🚀 Try It Now", url: buttonUrl }])
              : undefined;

          const result = await Promise.race([
            bot.telegram.sendMessage(chatId, chunk, {
              parse_mode: "HTML",
              reply_markup: replyMarkup,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Telegram API timeout")), 25_000),
            ),
          ]);

          lastMessageId = result.message_id;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Failed to send message";
      logger.error("[TelegramAppAutomation] Failed to post announcement", {
        appId,
        chatId,
        error: lastError,
        hasImage: !!promotionalImageUrl,
      });
    }

    if (lastMessageId) {
      const currentConfig = app.telegram_automation || {
        enabled: false,
        autoReply: true,
        autoAnnounce: false,
        announceIntervalMin: 120,
        announceIntervalMax: 240,
      };

      await appsRepository.update(appId, {
        telegram_automation: {
          ...currentConfig,
          lastAnnouncementAt: new Date().toISOString(),
          totalMessages: (currentConfig.totalMessages || 0) + 1,
        },
      });

      logger.info("[TelegramAppAutomation] Announcement posted", {
        appId,
        chatId,
        messageId: lastMessageId,
        hasImage: !!promotionalImageUrl,
      });

      return { success: true, messageId: lastMessageId, chatId };
    }

    return { success: false, error: lastError };
  }

  /**
   * Handle an incoming message for an app.
   */
  async handleIncomingMessage(
    organizationId: string,
    appId: string,
    message: {
      chatId: number | string;
      messageId: number;
      text: string;
      userName?: string;
      replyToMessageId?: number;
    },
  ): Promise<PostResult> {
    const app = await this.getAppForOrg(organizationId, appId);
    const config = app.telegram_automation;

    if (!config?.enabled || !config?.autoReply) {
      return { success: false, error: "Auto-reply not enabled" };
    }

    const botToken = await telegramAutomationService.getBotToken(organizationId);
    if (!botToken) {
      return { success: false, error: "Bot not connected" };
    }

    const replyText = await this.generateReply(organizationId, app, message.text, message.userName);

    const bot = new Telegraf(botToken);

    try {
      const result = await Promise.race([
        bot.telegram.sendMessage(message.chatId, replyText, {
          reply_parameters: { message_id: message.messageId },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Telegram API timeout")), 25_000),
        ),
      ]);

      const currentConfig = app.telegram_automation || {
        enabled: false,
        autoReply: true,
        autoAnnounce: false,
        announceIntervalMin: 120,
        announceIntervalMax: 240,
      };

      await appsRepository.update(appId, {
        telegram_automation: {
          ...currentConfig,
          totalMessages: (currentConfig.totalMessages || 0) + 1,
        },
      });

      return {
        success: true,
        messageId: result.message_id,
        chatId: message.chatId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to send reply";
      logger.error("[TelegramAppAutomation] Failed to handle message", {
        appId,
        chatId: message.chatId,
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get all apps with active Telegram automation.
   */
  async getAppsWithActiveAutomation(organizationId: string): Promise<App[]> {
    const apps = await appsRepository.listByOrganization(organizationId);
    return apps.filter((app) => app.telegram_automation?.enabled);
  }

  /**
   * Check if an app needs an announcement based on interval settings.
   * Used by scheduled workers to determine when to post.
   */
  isAnnouncementDue(app: App): boolean {
    const config = app.telegram_automation as TelegramAutomationConfig | null;
    if (!config?.enabled || !config?.autoAnnounce) return false;

    // If never announced, it's due
    if (!config.lastAnnouncementAt) return true;

    const lastAnnouncement = new Date(config.lastAnnouncementAt);
    const now = new Date();
    const minutesSince = (now.getTime() - lastAnnouncement.getTime()) / (1000 * 60);

    // Use a random interval between min and max for natural timing
    const minInterval =
      config.announceIntervalMin || TELEGRAM_AUTOMATION_DEFAULTS.announceIntervalMin;
    const maxInterval =
      config.announceIntervalMax || TELEGRAM_AUTOMATION_DEFAULTS.announceIntervalMax;
    const targetInterval = minInterval + Math.random() * (maxInterval - minInterval);

    return minutesSince >= targetInterval;
  }
}

export const telegramAppAutomationService = new TelegramAppAutomationService();
