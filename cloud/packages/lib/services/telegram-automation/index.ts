/**
 * Telegram Automation Service
 *
 * Handles bot token validation, credential storage, and webhook management
 * for Telegram bot integration. Uses Telegraf library directly.
 */

import { Telegraf } from "telegraf";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";

// Use ELIZA_API_URL (ngrok) for local dev webhooks, otherwise NEXT_PUBLIC_APP_URL
const WEBHOOK_BASE_URL =
  process.env.ELIZA_API_URL || process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

// Cache TTL for connection status (5 minutes)
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedStatus {
  status: TelegramConnectionStatus;
  cachedAt: number;
}

export interface TelegramBotInfo {
  botId: number;
  botUsername: string;
  firstName: string;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
}

export interface TelegramConnectionStatus {
  connected: boolean;
  configured: boolean;
  botUsername?: string;
  botId?: number;
  error?: string;
}

export interface TelegramCredentials {
  botToken: string;
  botUsername: string;
  botId: number;
  webhookSecret?: string;
}

class TelegramAutomationService {
  // In-memory cache for connection status
  private statusCache = new Map<string, CachedStatus>();

  /**
   * Invalidate cached status for an organization.
   */
  invalidateStatusCache(organizationId: string): void {
    this.statusCache.delete(organizationId);
  }

  /**
   * Validate a bot token by calling Telegram's getMe API.
   */
  async validateBotToken(token: string): Promise<{
    valid: boolean;
    botInfo?: TelegramBotInfo;
    error?: string;
  }> {
    if (!token || !token.includes(":")) {
      return { valid: false, error: "Invalid token format" };
    }

    try {
      const bot = new Telegraf(token);
      const me = await bot.telegram.getMe();

      logger.info("[TelegramAutomation] Token validated successfully", {
        botId: me.id,
        botUsername: me.username,
      });

      return {
        valid: true,
        botInfo: {
          botId: me.id,
          botUsername: me.username || `bot${me.id}`,
          firstName: me.first_name,
          canJoinGroups: me.can_join_groups || false,
          canReadAllGroupMessages: me.can_read_all_group_messages || false,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.warn("[TelegramAutomation] Token validation failed", {
        error: message,
      });
      return { valid: false, error: message };
    }
  }

  /**
   * Store bot credentials in the secrets service.
   */
  async storeCredentials(
    organizationId: string,
    userId: string,
    credentials: TelegramCredentials,
  ): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "telegram-automation",
    };

    const createOrUpdateSecret = async (name: string, value: string) => {
      try {
        await secretsService.create(
          {
            organizationId,
            name,
            value,
            scope: "organization",
            createdBy: userId,
          },
          audit,
        );
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          logger.info("[TelegramAutomation] Secret exists, updating", { name });
          const existingSecrets = await secretsService.list(organizationId);
          const existingSecret = existingSecrets.find((s) => s.name === name);
          if (existingSecret) {
            await secretsService.rotate(existingSecret.id, organizationId, value, audit);
            return;
          }
        }

        throw err;
      }
    };

    await createOrUpdateSecret("TELEGRAM_BOT_TOKEN", credentials.botToken);
    await createOrUpdateSecret("TELEGRAM_BOT_USERNAME", credentials.botUsername);
    await createOrUpdateSecret("TELEGRAM_BOT_ID", String(credentials.botId));

    // Generate and store a webhook secret for signature verification
    const webhookSecret = credentials.webhookSecret || crypto.randomUUID();
    await createOrUpdateSecret("TELEGRAM_WEBHOOK_SECRET", webhookSecret);

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[TelegramAutomation] Credentials stored", {
      organizationId,
      botUsername: credentials.botUsername,
    });
  }

  /**
   * Remove bot credentials (disconnect).
   */
  async removeCredentials(organizationId: string, userId: string): Promise<void> {
    const audit = {
      actorType: "user" as const,
      actorId: userId,
      source: "telegram-automation",
    };

    try {
      await this.removeWebhook(organizationId);
    } catch {
      // Webhook might not be set
    }

    const secretNames = [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_BOT_USERNAME",
      "TELEGRAM_BOT_ID",
      "TELEGRAM_WEBHOOK_SECRET",
    ];

    const existingSecrets = await secretsService.list(organizationId);

    for (const name of secretNames) {
      const secret = existingSecrets.find((s) => s.name === name);
      if (secret) {
        try {
          await secretsService.delete(secret.id, organizationId, audit);
          logger.info("[TelegramAutomation] Deleted secret", {
            name,
            organizationId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("Secret not found") || message.includes("Failed to delete secret")) {
            logger.debug("[TelegramAutomation] Secret already removed during disconnect", {
              name,
              organizationId,
            });
            continue;
          }
          throw error;
        }
      }
    }

    // Invalidate cache so next status check fetches fresh data
    this.invalidateStatusCache(organizationId);

    logger.info("[TelegramAutomation] Credentials removed", { organizationId });
  }

  /**
   * Get bot token for an organization.
   */
  async getBotToken(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, "TELEGRAM_BOT_TOKEN");
  }

  /**
   * Get webhook secret for an organization.
   */
  async getWebhookSecret(organizationId: string): Promise<string | null> {
    return secretsService.get(organizationId, "TELEGRAM_WEBHOOK_SECRET");
  }

  /**
   * Get connection status for an organization.
   * Results are cached for STATUS_CACHE_TTL_MS to reduce API calls.
   */
  async getConnectionStatus(
    organizationId: string,
    options?: { skipCache?: boolean },
  ): Promise<TelegramConnectionStatus> {
    // Check cache first (unless explicitly skipped)
    if (!options?.skipCache) {
      const cached = this.statusCache.get(organizationId);
      if (cached && Date.now() - cached.cachedAt < STATUS_CACHE_TTL_MS) {
        return cached.status;
      }
    }

    const [botToken, botUsername, botId] = await Promise.all([
      secretsService.get(organizationId, "TELEGRAM_BOT_TOKEN"),
      secretsService.get(organizationId, "TELEGRAM_BOT_USERNAME"),
      secretsService.get(organizationId, "TELEGRAM_BOT_ID"),
    ]);

    if (!botToken) {
      const status: TelegramConnectionStatus = {
        connected: false,
        configured: false,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    }

    try {
      const bot = new Telegraf(botToken);
      const me = await bot.telegram.getMe();

      const status: TelegramConnectionStatus = {
        connected: true,
        configured: true,
        botUsername: me.username || botUsername || undefined,
        botId: me.id,
      };
      this.statusCache.set(organizationId, { status, cachedAt: Date.now() });
      return status;
    } catch (error) {
      logger.warn("[TelegramAutomation] Token validation failed during status check", {
        organizationId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      // Return stored data even if validation fails (don't cache error state)
      const status: TelegramConnectionStatus = {
        connected: true,
        configured: true,
        botUsername: botUsername || undefined,
        botId: botId ? parseInt(botId, 10) : undefined,
        error: "Token may be invalid. Try reconnecting.",
      };
      // Cache with shorter TTL for error state (1 minute)
      this.statusCache.set(organizationId, {
        status,
        cachedAt: Date.now() - STATUS_CACHE_TTL_MS + 60_000,
      });
      return status;
    }
  }

  /**
   * Set webhook for receiving updates from Telegram.
   * Requires HTTPS URL - use ELIZA_API_URL with ngrok for local development.
   */
  async setWebhook(organizationId: string): Promise<{ success: boolean; error?: string }> {
    const botToken = await this.getBotToken(organizationId);
    if (!botToken) {
      return { success: false, error: "Bot token not found" };
    }

    // Telegram requires HTTPS for webhooks
    if (!WEBHOOK_BASE_URL.startsWith("https://")) {
      logger.warn("[TelegramAutomation] Skipping webhook - HTTPS required", {
        organizationId,
        hint: "Set ELIZA_API_URL with your ngrok HTTPS URL for local development",
      });
      return {
        success: true, // Don't fail the connection, just skip webhook
        error: "Webhook skipped - HTTPS required. Set ELIZA_API_URL with ngrok URL for local dev.",
      };
    }

    try {
      const bot = new Telegraf(botToken);
      const webhookUrl = this.getWebhookUrl(organizationId);

      // Get the webhook secret for signature verification
      const webhookSecret = await this.getWebhookSecret(organizationId);

      await bot.telegram.setWebhook(webhookUrl, {
        allowed_updates: ["message", "callback_query", "channel_post", "my_chat_member"],
        drop_pending_updates: true,
        secret_token: webhookSecret || undefined,
      });

      logger.info("[TelegramAutomation] Webhook set", {
        organizationId,
        webhookUrl,
        hasSecretToken: !!webhookSecret,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("[TelegramAutomation] Failed to set webhook", {
        organizationId,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Get the webhook URL for an organization.
   */
  getWebhookUrl(organizationId: string): string {
    return `${WEBHOOK_BASE_URL}/api/v1/telegram/webhook/${organizationId}`;
  }

  /**
   * Remove webhook for an organization.
   */
  async removeWebhook(organizationId: string): Promise<void> {
    const botToken = await this.getBotToken(organizationId);
    if (!botToken) return;
    if (!botToken.includes(":")) {
      logger.warn("[TelegramAutomation] Skipping webhook removal for invalid bot token format", {
        organizationId,
      });
      return;
    }

    try {
      const bot = new Telegraf(botToken);
      await bot.telegram.deleteWebhook({ drop_pending_updates: true });

      logger.info("[TelegramAutomation] Webhook removed", { organizationId });
    } catch (error) {
      logger.warn("[TelegramAutomation] Failed to remove webhook", {
        organizationId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Get a Telegraf bot instance for an organization.
   */
  async getBotInstance(organizationId: string): Promise<Telegraf | null> {
    const botToken = await this.getBotToken(organizationId);
    if (!botToken) return null;
    return new Telegraf(botToken);
  }

  /**
   * Send a message to a chat.
   */
  async sendMessage(
    organizationId: string,
    chatId: string | number,
    text: string,
    options?: {
      parseMode?: "MarkdownV2" | "HTML";
      replyMarkup?: {
        inline_keyboard: Array<
          Array<{ text: string; url: string } | { text: string; callback_data: string }>
        >;
      };
      disableWebPagePreview?: boolean;
    },
  ): Promise<{ success: boolean; messageId?: number; error?: string }> {
    const bot = await this.getBotInstance(organizationId);
    if (!bot) {
      return { success: false, error: "Bot not configured" };
    }

    try {
      const result = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: options?.parseMode,
        reply_markup: options?.replyMarkup,
        link_preview_options: options?.disableWebPagePreview ? { is_disabled: true } : undefined,
      });

      return { success: true, messageId: result.message_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("[TelegramAutomation] Failed to send message", {
        organizationId,
        chatId,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  /**
   * Check if Telegram is configured (has stored credentials).
   */
  async isConfigured(organizationId: string): Promise<boolean> {
    const token = await this.getBotToken(organizationId);
    return Boolean(token);
  }
}

export const telegramAutomationService = new TelegramAutomationService();
