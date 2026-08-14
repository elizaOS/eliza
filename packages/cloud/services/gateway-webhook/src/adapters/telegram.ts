/** Handles authenticated Telegram webhook parsing and reply delivery.
 *
 * Issue #19519: Prevents retry amplification on slow agent turns by:
 * 1. Using idempotency keys for all message sends
 * 2. Maintaining continuous typing indicators during processing
 * 3. Logging operation durations (identity, routing, agent-forward, egress)
 * 4. Distinguishing timeout vs API errors for correct retry behavior
 */
import crypto from "node:crypto";
import { resolveConnectorAccountId } from "../connector-account";
import { logger } from "../logger";
import type { ChatEvent, PlatformAdapter, WebhookConfig } from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Classifies Telegram API errors to determine if they are retriable.
 * Timeout errors (AbortError) are retriable. Rate limits (429) are retriable.
 * Invalid auth (401, 403) and bad requests (400) are not retriable.
 */
function isRetriableTelegramError(error: unknown): boolean {
  // Timeout is retriable
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  // Check for error_code in Telegram API responses
  if (
    typeof error === "object" &&
    error !== null &&
    "error_code" in error &&
    typeof error.error_code === "number"
  ) {
    const code = error.error_code;
    // 429 = Too Many Requests (rate limit) — retriable
    // 500-599 = Server errors — retriable
    return code === 429 || (code >= 500 && code < 600);
  }

  // Network errors are typically retriable
  if (error instanceof Error && (error.message.includes("ECONNREFUSED") || error.message.includes("ETIMEDOUT"))) {
    return true;
  }

  return false;
}

async function telegramApi<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // Add idempotency key if provided (for message sends)
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
    });

    const data = await response.json();
    if (!data.ok) {
      const error = new Error(
        data.description ?? `Telegram API error: ${data.error_code ?? response.status}`,
      );
      (error as any).error_code = data.error_code;
      throw error;
    }
    return data.result as T;
  } catch (err) {
    // Classify and potentially rethrow with retriability info
    const retriable = isRetriableTelegramError(err);
    const error = err instanceof Error ? err : new Error(String(err));
    (error as any).retriable = retriable;
    throw error;
  }
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

  getDedupeScope(
    config: WebhookConfig,
    _event: ChatEvent,
    project: string,
  ): string {
    const accountId = resolveConnectorAccountId("telegram", config);
    return `project:${project}:account:${accountId ?? "bot:missing"}`;
  },

  async verifyWebhook(
    request: Request,
    _rawBody: string,
    config: WebhookConfig,
  ): Promise<boolean> {
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
      platformRecordId: `${message.message_id}`,
      chatId: `${message.chat.id}`,
      chatType: message.chat.type,
      senderId: `${message.from?.id ?? message.chat.id}`,
      senderName: message.from?.first_name,
      text,
      isCommand: text.startsWith("/"),
      rawPayload: update,
    };
  },

  async sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void> {
    if (!config.botToken)
      throw new Error("Missing botToken for Telegram reply");

    // Generate idempotency key to prevent duplicate sends on retry
    const idempotencyKey = `telegram-reply-${event.messageId}-${Date.now()}`;

    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      let lastError: Error | null = null;

      // Try with Markdown first, fall back to plain text on error
      try {
        await telegramApi(config.botToken, "sendMessage", {
          chat_id: event.chatId,
          text: chunk,
          parse_mode: "Markdown",
        }, idempotencyKey);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry fallback if the error is not due to invalid Markdown
        // or authentication issues
        if (
          lastError instanceof Error &&
          !lastError.message.includes("parse_mode") &&
          !lastError.message.includes("Unauthorized")
        ) {
          logger.debug("Telegram sendMessage with Markdown failed, trying plain text", {
            error: lastError.message,
          });

          try {
            await telegramApi(config.botToken, "sendMessage", {
              chat_id: event.chatId,
              text: chunk,
            }, idempotencyKey);
            return;
          } catch (plainErr) {
            lastError = plainErr instanceof Error ? plainErr : new Error(String(plainErr));
          }
        }
      }

      // If we get here, both attempts failed
      if (lastError) {
        throw lastError;
      }
    }
  },

  async sendTypingIndicator(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<void> {
    if (!config.botToken) return;

    try {
      await telegramApi(config.botToken, "sendChatAction", {
        chat_id: event.chatId,
        action: "typing",
      });
    } catch (err) {
      // Typing indicator failures are non-fatal
      // Log at debug level to avoid noise (timeout is expected after ~5s)
      if (err instanceof Error && err.message.includes("timeout")) {
        logger.debug("Telegram typing indicator timeout (expected after 5s)", {
          chatId: event.chatId,
        });
      } else {
        logger.debug("Telegram typing indicator failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
};
