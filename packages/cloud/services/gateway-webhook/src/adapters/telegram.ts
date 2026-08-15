/** Handles authenticated Telegram webhook parsing and reply delivery. */
import crypto from "node:crypto";
import { resolveConnectorAccountId } from "../connector-account";
import { logger } from "../logger";
import type {
  ChatEvent,
  PlatformAdapter,
  PlatformDeliveryReceipt,
  ResolvedVoiceNote,
  WebhookConfig,
} from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_HOSTED_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 8 * 1024 * 1024;
const TELEGRAM_API_TIMEOUT_MS = 10_000;
export const TELEGRAM_VOICE_MAX_DURATION_SECONDS = 15 * 60;
const TELEGRAM_FILE_FETCH_TIMEOUT_MS = 30_000;

class TelegramApiTransportError extends Error {
  constructor(method: string) {
    super(`Telegram API ${method} transport failed`);
    this.name = "TelegramApiTransportError";
  }
}

export class TelegramApiResponseError extends Error {
  constructor(
    message: string,
    readonly errorCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramApiResponseError";
  }
}

function isMarkdownFormattingRejection(
  error: TelegramApiResponseError,
): boolean {
  return (
    error.errorCode === 400 &&
    /(?:can't parse entities|can't find end of (?:the )?entity|unsupported (?:start|end) tag)/i.test(
      error.message,
    )
  );
}

async function telegramApi<T>(
  botToken: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/${method}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    // error-policy:J3 a fetch implementation may include the credential-bearing
    // URL in its error, so translate before the adapter boundary logs it.
    throw new TelegramApiTransportError(method);
  }
  const data = (await response.json()) as {
    ok?: unknown;
    result?: unknown;
    description?: unknown;
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
  };
  if (!data.ok) {
    const errorCode =
      typeof data.error_code === "number" &&
      Number.isInteger(data.error_code) &&
      data.error_code >= 400 &&
      data.error_code <= 599
        ? data.error_code
        : response.status;
    const retryAfterSeconds =
      typeof data.parameters?.retry_after === "number" &&
      Number.isInteger(data.parameters.retry_after) &&
      data.parameters.retry_after > 0
        ? data.parameters.retry_after
        : undefined;
    throw new TelegramApiResponseError(
      typeof data.description === "string"
        ? data.description
        : `Telegram API error: ${errorCode}`,
      errorCode,
      retryAfterSeconds,
    );
  }
  return data.result as T;
}

function exceedsTelegramVoiceSizeLimit(size: number): boolean {
  return (
    size > TELEGRAM_HOSTED_FILE_MAX_BYTES || size > TELEGRAM_VOICE_MAX_BYTES
  );
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
  voice?: {
    file_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function sendTelegramReply(
  config: WebhookConfig,
  event: ChatEvent,
  text: string,
): Promise<PlatformDeliveryReceipt> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram reply");

  const providerMessageIds: string[] = [];
  for (const chunk of splitMessage(text)) {
    try {
      const message = await telegramApi<TelegramMessage>(
        config.botToken,
        "sendMessage",
        {
          chat_id: event.chatId,
          text: chunk,
          parse_mode: "Markdown",
        },
      );
      providerMessageIds.push(String(message.message_id));
    } catch (err) {
      if (
        !(err instanceof TelegramApiResponseError) ||
        !isMarkdownFormattingRejection(err)
      ) {
        throw err;
      }
      logger.warn("Telegram sendMessage failed, retrying without Markdown", {
        error: err.message,
      });
      const message = await telegramApi<TelegramMessage>(
        config.botToken,
        "sendMessage",
        {
          chat_id: event.chatId,
          text: chunk,
        },
      );
      providerMessageIds.push(String(message.message_id));
    }
  }
  return { providerMessageIds };
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
    const voice = message.voice;
    if (!text && !voice) return null;

    if (voice) {
      if (
        !voice.file_id ||
        voice.file_id.length > 256 ||
        !Number.isInteger(voice.duration) ||
        voice.duration < 0 ||
        voice.duration > TELEGRAM_VOICE_MAX_DURATION_SECONDS ||
        (voice.file_size !== undefined &&
          (!Number.isInteger(voice.file_size) ||
            voice.file_size <= 0 ||
            exceedsTelegramVoiceSizeLimit(voice.file_size))) ||
        (voice.mime_type !== undefined && voice.mime_type !== "audio/ogg")
      ) {
        logger.warn("Rejected invalid Telegram voice-note metadata");
        return null;
      }
    }

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
      ...(voice
        ? {
            voiceNote: {
              fileId: voice.file_id,
              durationSeconds: voice.duration,
              ...(voice.file_size !== undefined
                ? { sizeBytes: voice.file_size }
                : {}),
              mimeType: "audio/ogg" as const,
            },
          }
        : {}),
    };
  },

  async resolveVoiceNote(
    config: WebhookConfig,
    event: ChatEvent,
  ): Promise<ResolvedVoiceNote> {
    if (!config.botToken) {
      throw new Error("Missing botToken for Telegram voice download");
    }
    const voice = event.voiceNote;
    if (!voice) throw new Error("Telegram event has no voice note");

    let file: { file_path?: string; file_size?: number };
    try {
      file = await telegramApi(config.botToken, "getFile", {
        file_id: voice.fileId,
      });
    } catch {
      // error-policy:J3 sanitize the credential-bearing provider request at the
      // adapter boundary so a fetch implementation cannot put its URL in logs.
      throw new Error("Telegram getFile request failed");
    }
    const filePath = file.file_path;
    if (
      !filePath ||
      filePath.length > 512 ||
      filePath.startsWith("/") ||
      filePath.split("/").includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(filePath)
    ) {
      throw new Error("Telegram getFile returned an invalid file path");
    }
    const reportedSize = file.file_size ?? voice.sizeBytes;
    if (
      reportedSize !== undefined &&
      (!Number.isInteger(reportedSize) ||
        reportedSize <= 0 ||
        exceedsTelegramVoiceSizeLimit(reportedSize))
    ) {
      throw new Error("Telegram voice note exceeds the hosted download limit");
    }

    let response: Response;
    try {
      response = await fetch(
        `${TELEGRAM_API_BASE}/file/bot${config.botToken}/${filePath}`,
        { signal: AbortSignal.timeout(TELEGRAM_FILE_FETCH_TIMEOUT_MS) },
      );
    } catch {
      // error-policy:J3 the token-bearing URL is secret input and must not be
      // retained in the propagated fetch error or structured service logs.
      throw new Error("Telegram voice download transport failed");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Telegram voice download failed (${response.status})`);
    }
    const contentLength = Number.parseInt(
      response.headers.get("content-length") ?? "",
      10,
    );
    if (
      Number.isFinite(contentLength) &&
      contentLength > TELEGRAM_VOICE_MAX_BYTES
    ) {
      await response.body.cancel();
      throw new Error("Telegram voice note exceeds the hosted download limit");
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > TELEGRAM_VOICE_MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          "Telegram voice note exceeds the hosted download limit",
        );
      }
      chunks.push(value);
    }
    if (received === 0) throw new Error("Telegram voice note was empty");
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.subarray(0, 4).toString("ascii") !== "OggS") {
      throw new Error("Telegram voice note did not contain an Ogg stream");
    }
    if (reportedSize !== undefined && received !== reportedSize) {
      throw new Error(
        "Telegram voice note size did not match provider metadata",
      );
    }

    return {
      bytesBase64: bytes.toString("base64"),
      mimeType: "audio/ogg",
      filename: `telegram-${event.messageId}.ogg`,
      sizeBytes: received,
      durationSeconds: voice.durationSeconds,
    };
  },

  async sendReply(
    config: WebhookConfig,
    event: ChatEvent,
    text: string,
  ): Promise<void> {
    await sendTelegramReply(config, event, text);
  },

  async sendReplyWithReceipt(config, event, text) {
    return sendTelegramReply(config, event, text);
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
    } catch {
      // Fire-and-forget
    }
  },
};
