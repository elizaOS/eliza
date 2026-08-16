/**
 * Web-standard Telegram webhook parsing, verification, feedback, media, and
 * reply delivery shared by the Cloudflare edge and the Railway gateway.
 * Provider credentials stay in the caller's runtime and are never logged.
 */

import type {
  TelegramDeliveryPlan,
  TelegramProviderSendOutcome,
} from "./telegram-delivery";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_HOSTED_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 8 * 1024 * 1024;
const TELEGRAM_API_TIMEOUT_MS = 10_000;
export const TELEGRAM_VOICE_MAX_DURATION_SECONDS = 15 * 60;
const TELEGRAM_FILE_FETCH_TIMEOUT_MS = 30_000;

export interface TelegramConnectorLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface TelegramConnectorConfig {
  botToken?: string;
  webhookSecret?: string;
}

export interface TelegramConnectorEvent {
  platform: "telegram";
  messageId: string;
  platformRecordId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  text: string;
  isCommand: boolean;
  providerSentAtMs?: number;
  voiceNote?: {
    fileId: string;
    durationSeconds: number;
    sizeBytes?: number;
    mimeType: "audio/ogg";
  };
  rawPayload: unknown;
}

export interface TelegramDeliveryReceipt {
  providerMessageIds: string[];
}

export interface TelegramResolvedVoiceNote {
  bytesBase64: string;
  mimeType: "audio/ogg";
  filename: string;
  sizeBytes: number;
  durationSeconds: number;
}

interface TelegramMessage {
  message_id: number;
  date?: number;
  from?: {
    id: number;
    first_name: string;
    username?: string;
    is_bot?: boolean;
  };
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
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

class TelegramApiTransportError extends Error {
  constructor(method: string) {
    super(`Telegram API ${method} transport failed`);
    this.name = "TelegramApiTransportError";
  }
}

class TelegramApiUnknownResponseError extends Error {
  constructor(method: string) {
    super(`Telegram API ${method} returned an invalid response`);
    this.name = "TelegramApiUnknownResponseError";
  }
}

export class TelegramUnknownAcceptanceError extends Error {
  override readonly name = "TelegramUnknownAcceptanceError";
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

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const maxLength = Math.max(actual.length, expected.length);
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < maxLength; index += 1) {
    mismatch |=
      (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function verifyTelegramWebhook(
  request: Request,
  webhookSecret: string | undefined,
): boolean {
  if (!webhookSecret) return false;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  return supplied !== null && constantTimeTextEqual(supplied, webhookSecret);
}

function exceedsTelegramVoiceSizeLimit(size: number): boolean {
  return (
    size > TELEGRAM_HOSTED_FILE_MAX_BYTES || size > TELEGRAM_VOICE_MAX_BYTES
  );
}

export function parseTelegramWebhook(
  rawBody: string,
  logger?: TelegramConnectorLogger,
): TelegramConnectorEvent | null {
  let update: TelegramUpdate;
  try {
    update = JSON.parse(rawBody) as TelegramUpdate;
  } catch {
    logger?.warn("Failed to parse Telegram webhook payload");
    return null;
  }

  const message = update.message;
  if (message?.chat.type !== "private") return null;
  const text = message.text || message.caption || "";
  const voice = message.voice;
  if (!text && !voice) return null;
  if (message.from?.is_bot) return null;

  if (
    voice &&
    (!voice.file_id ||
      voice.file_id.length > 256 ||
      !Number.isInteger(voice.duration) ||
      voice.duration < 0 ||
      voice.duration > TELEGRAM_VOICE_MAX_DURATION_SECONDS ||
      (voice.file_size !== undefined &&
        (!Number.isInteger(voice.file_size) ||
          voice.file_size <= 0 ||
          exceedsTelegramVoiceSizeLimit(voice.file_size))) ||
      (voice.mime_type !== undefined && voice.mime_type !== "audio/ogg"))
  ) {
    logger?.warn("Rejected invalid Telegram voice-note metadata");
    return null;
  }

  return {
    platform: "telegram",
    messageId: String(update.update_id),
    platformRecordId: String(message.message_id),
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    senderId: String(message.from?.id ?? message.chat.id),
    senderName: message.from?.first_name,
    text,
    isCommand: text.startsWith("/"),
    ...(typeof message.date === "number" &&
    Number.isInteger(message.date) &&
    message.date > 0
      ? { providerSentAtMs: message.date * 1_000 }
      : {}),
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
  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    // error-policy:J3 the credential-bearing provider URL is never propagated.
    throw new TelegramApiTransportError(method);
  }
  let data: {
    ok?: unknown;
    result?: unknown;
    description?: unknown;
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
  };
  try {
    data = (await response.json()) as typeof data;
  } catch {
    // error-policy:J3 Telegram is an untrusted JSON boundary.
    throw new TelegramApiUnknownResponseError(method);
  }
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

function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 <= maxLength) {
      current += `${current ? "\n" : ""}${line}`;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= maxLength) {
      current = line;
      continue;
    }
    let remaining = line;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    current = remaining;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function digestChunks(chunks: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(chunks));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function prepareTelegramReply(
  text: string,
): Promise<TelegramDeliveryPlan> {
  const chunks = splitMessage(text);
  return { chunks, contentDigest: await digestChunks(chunks) };
}

export async function sendTelegramReplyChunk(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
  chunk: string,
  logger?: TelegramConnectorLogger,
): Promise<TelegramProviderSendOutcome> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram reply");

  const send = async (
    parseMarkdown: boolean,
  ): Promise<{
    outcome: TelegramProviderSendOutcome;
    markdownFormattingRejection: boolean;
  }> => {
    try {
      const message = await telegramApi<TelegramMessage>(
        config.botToken as string,
        "sendMessage",
        {
          chat_id: event.chatId,
          text: chunk,
          ...(parseMarkdown ? { parse_mode: "Markdown" } : {}),
        },
      );
      if (
        !message ||
        typeof message !== "object" ||
        !Number.isInteger(message.message_id)
      ) {
        return {
          outcome: { acceptance: "unknown" },
          markdownFormattingRejection: false,
        };
      }
      return {
        outcome: {
          acceptance: "accepted",
          providerMessageId: String(message.message_id),
        },
        markdownFormattingRejection: false,
      };
    } catch (error) {
      if (error instanceof TelegramApiResponseError) {
        return {
          outcome: {
            acceptance: "not_accepted",
            errorCode: error.errorCode,
            ...(error.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: error.retryAfterSeconds }),
          },
          markdownFormattingRejection:
            parseMarkdown && isMarkdownFormattingRejection(error),
        };
      }
      if (
        error instanceof TelegramApiTransportError ||
        error instanceof TelegramApiUnknownResponseError
      ) {
        return {
          outcome: { acceptance: "unknown" },
          markdownFormattingRejection: false,
        };
      }
      throw error;
    }
  };

  const markdownResult = await send(true);
  if (!markdownResult.markdownFormattingRejection) {
    return markdownResult.outcome;
  }
  logger?.warn("Telegram sendMessage failed, retrying without Markdown", {
    errorCode:
      markdownResult.outcome.acceptance === "not_accepted"
        ? markdownResult.outcome.errorCode
        : undefined,
  });
  return (await send(false)).outcome;
}

export async function sendTelegramReply(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
  text: string,
  logger?: TelegramConnectorLogger,
): Promise<TelegramDeliveryReceipt> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram reply");
  const providerMessageIds: string[] = [];
  const plan = await prepareTelegramReply(text);
  for (const chunk of plan.chunks) {
    const result = await sendTelegramReplyChunk(config, event, chunk, logger);
    if (result.acceptance === "accepted") {
      providerMessageIds.push(result.providerMessageId);
      continue;
    }
    if (result.acceptance === "not_accepted") {
      throw new TelegramApiResponseError(
        `Telegram API error: ${result.errorCode}`,
        result.errorCode,
        result.retryAfterSeconds,
      );
    }
    throw new TelegramUnknownAcceptanceError(
      "Telegram reply acceptance could not be determined",
    );
  }
  return { providerMessageIds };
}

export async function sendTelegramTyping(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
): Promise<void> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram typing");
  await telegramApi(config.botToken, "sendChatAction", {
    chat_id: event.chatId,
    action: "typing",
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export async function resolveTelegramVoiceNote(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
): Promise<TelegramResolvedVoiceNote> {
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
    // error-policy:J3 sanitize the credential-bearing request at this boundary.
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
    // error-policy:J3 the token-bearing URL must not enter service logs.
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
      throw new Error("Telegram voice note exceeds the hosted download limit");
    }
    chunks.push(value);
  }
  if (received === 0) throw new Error("Telegram voice note was empty");
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "OggS") {
    throw new Error("Telegram voice note did not contain an Ogg stream");
  }
  if (reportedSize !== undefined && received !== reportedSize) {
    throw new Error("Telegram voice note size did not match provider metadata");
  }
  return {
    bytesBase64: bytesToBase64(bytes),
    mimeType: "audio/ogg",
    filename: `telegram-${event.messageId}.ogg`,
    sizeBytes: received,
    durationSeconds: voice.durationSeconds,
  };
}
