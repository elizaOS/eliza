import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";

/**
 * Update mode for receiving Telegram updates.
 * - polling: Long-polling (default, suitable for development)
 * - webhook: Webhook-based (recommended for production)
 */
export type TelegramUpdateMode = "polling" | "webhook";

export const telegramEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "Telegram bot token is required"),
  TELEGRAM_API_ROOT: z.string().optional(),
  TELEGRAM_UPDATE_MODE: z.enum(["polling", "webhook"]).optional().default("polling"),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_PATH: z.string().optional(),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_ALLOWED_CHATS: z.string().optional(),
  TELEGRAM_PROXY_URL: z.string().url().optional(),
  TELEGRAM_DROP_PENDING_UPDATES: z.coerce.boolean().optional().default(true),
  TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES: z.coerce.boolean().optional().default(true),
  TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS: z.coerce.boolean().optional().default(false),
});

export type TelegramConfig = z.infer<typeof telegramEnvSchema>;

/**
 * Extended configuration with parsed values.
 */
export interface TelegramSettings {
  botToken: string;
  apiRoot: string;
  updateMode: TelegramUpdateMode;
  webhookUrl?: string;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  allowedChatIds: number[];
  proxyUrl?: string;
  dropPendingUpdates: boolean;
  shouldIgnoreBotMessages: boolean;
  shouldRespondOnlyToMentions: boolean;
}

/**
 * Parse allowed chats from JSON string or comma-separated list.
 */
function parseAllowedChats(value: string | undefined): number[] {
  if (!value) return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  // Try parsing as JSON array first
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((id) => {
          const num = typeof id === "string" ? parseInt(id, 10) : Number(id);
          return Number.isFinite(num) ? num : 0;
        })
        .filter((id) => id !== 0);
    }
  }

  // Otherwise parse as comma-separated
  return trimmed
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((id) => Number.isFinite(id));
}

export async function validateTelegramConfig(
  runtime: IAgentRuntime
): Promise<TelegramConfig | null> {
  try {
    const config = {
      TELEGRAM_BOT_TOKEN:
        runtime.getSetting("TELEGRAM_BOT_TOKEN") || process.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_API_ROOT: runtime.getSetting("TELEGRAM_API_ROOT") || process.env.TELEGRAM_API_ROOT,
      TELEGRAM_UPDATE_MODE:
        runtime.getSetting("TELEGRAM_UPDATE_MODE") || process.env.TELEGRAM_UPDATE_MODE,
      TELEGRAM_WEBHOOK_URL:
        runtime.getSetting("TELEGRAM_WEBHOOK_URL") || process.env.TELEGRAM_WEBHOOK_URL,
      TELEGRAM_WEBHOOK_PATH:
        runtime.getSetting("TELEGRAM_WEBHOOK_PATH") || process.env.TELEGRAM_WEBHOOK_PATH,
      TELEGRAM_WEBHOOK_PORT:
        runtime.getSetting("TELEGRAM_WEBHOOK_PORT") || process.env.TELEGRAM_WEBHOOK_PORT,
      TELEGRAM_WEBHOOK_SECRET:
        runtime.getSetting("TELEGRAM_WEBHOOK_SECRET") || process.env.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_ALLOWED_CHATS:
        runtime.getSetting("TELEGRAM_ALLOWED_CHATS") || process.env.TELEGRAM_ALLOWED_CHATS,
      TELEGRAM_PROXY_URL:
        runtime.getSetting("TELEGRAM_PROXY_URL") || process.env.TELEGRAM_PROXY_URL,
      TELEGRAM_DROP_PENDING_UPDATES:
        runtime.getSetting("TELEGRAM_DROP_PENDING_UPDATES") ||
        process.env.TELEGRAM_DROP_PENDING_UPDATES,
      TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES:
        runtime.getSetting("TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES") ||
        process.env.TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES,
      TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS:
        runtime.getSetting("TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS") ||
        process.env.TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS,
    };

    return telegramEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Telegram configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

/**
 * Build TelegramSettings from validated config.
 */
export function buildTelegramSettings(config: TelegramConfig): TelegramSettings {
  return {
    botToken: config.TELEGRAM_BOT_TOKEN,
    apiRoot: config.TELEGRAM_API_ROOT || "https://api.telegram.org",
    updateMode: (config.TELEGRAM_UPDATE_MODE as TelegramUpdateMode) || "polling",
    webhookUrl: config.TELEGRAM_WEBHOOK_URL,
    webhookPath: config.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook",
    webhookPort: config.TELEGRAM_WEBHOOK_PORT,
    webhookSecret: config.TELEGRAM_WEBHOOK_SECRET,
    allowedChatIds: parseAllowedChats(config.TELEGRAM_ALLOWED_CHATS),
    proxyUrl: config.TELEGRAM_PROXY_URL,
    dropPendingUpdates: config.TELEGRAM_DROP_PENDING_UPDATES ?? true,
    shouldIgnoreBotMessages: config.TELEGRAM_SHOULD_IGNORE_BOT_MESSAGES ?? true,
    shouldRespondOnlyToMentions: config.TELEGRAM_SHOULD_RESPOND_ONLY_TO_MENTIONS ?? false,
  };
}
