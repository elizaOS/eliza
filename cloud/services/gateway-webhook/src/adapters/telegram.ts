import crypto from "crypto";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;

async function telegramApi<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(
      data.description ?? `Telegram API error: ${data.error_code ?? response.status}`,
    );
  }
  return data.result as T;
}

function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;

  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 <= maxLength) {
      current += (current ? "\n" : "") + line;
    } else {
      if (current) chunks.push(current);
      if (line.length > maxLength) {
        let remaining = line;
        while (remaining.length > maxLength) {
          chunks.push(remaining.slice(0, maxLength));
          remaining = remaining.slice(maxLength);
        }
        current = remaining;
      } else {
        current = line;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot?: boolean;
  };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string }>;
  document?: { file_id: string };
  voice?: { file_id: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export const telegramAdapter: PlatformAdapter = {
  platform: "telegram",

  async verifyWebhook(request: Request, _rawBody: string, config: WebhookConfig): Promise<boolean> {
    if (!config.webhookSecret) {
      logger.warn("Telegram webhook secret not configured — rejecting request");
      return false;
    }

    const headerSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!headerSecret) return false;

    const expected = Buffer.from(config.webhookSecret, "utf8");
    const received = Buffer.from(headerSecret, "utf8");
    if (expected.length !== received.length) return false;

    return crypto.timingSafeEqual(expected, received);
  },

  async extractEvent(rawBody: string): Promise<ChatEvent | null> {
    let update: TelegramUpdate;
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      logger.warn("Failed to parse Telegram webhook payload");
      return null;
    }

    const message = update.message;
    if (!message) return null;

    if (message.chat.type !== "private") return null;

    const text = message.text || message.caption || "";
    if (!text) return null;

    if (message.from?.is_bot) return null;

    return {
      platform: "telegram",
      messageId: `${update.update_id}`,
      chatId: `${message.chat.id}`,
      senderId: `${message.from?.id ?? message.chat.id}`,
      senderName: message.from?.first_name,
      text,
      isCommand: text.startsWith("/"),
      rawPayload: update,
    };
  },

  async sendReply(config: WebhookConfig, event: ChatEvent, text: string): Promise<void> {
    if (!config.botToken) throw new Error("Missing botToken for Telegram reply");

    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      try {
        await telegramApi(config.botToken, "sendMessage", {
          chat_id: event.chatId,
          text: chunk,
          parse_mode: "Markdown",
        });
      } catch (err) {
        logger.warn("Telegram sendMessage failed, retrying without Markdown", {
          error: err instanceof Error ? err.message : String(err),
        });
        await telegramApi(config.botToken, "sendMessage", {
          chat_id: event.chatId,
          text: chunk,
        });
      }
    }
  },

  async sendTypingIndicator(config: WebhookConfig, event: ChatEvent): Promise<void> {
    if (!config.botToken) return;
    try {
      await telegramApi(config.botToken, "sendChatAction", {
        chat_id: event.chatId,
        action: "typing",
      });
    } catch {
      // Fire-and-forget
    }
  },
};
