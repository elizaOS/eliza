/**
 * Web-standard Telegram webhook parsing, verification, feedback, media, and
 * reply delivery shared by the Cloudflare edge and the Railway gateway.
 * Provider credentials stay in the caller's runtime and are never logged.
 */

import { ElizaError } from "@elizaos/core";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_CONNECTOR_ACCOUNT_ID_HEADER =
  "X-Eliza-Connector-Account-Id";
export const TELEGRAM_HOSTED_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_VOICE_MAX_BYTES = 8 * 1024 * 1024;
const TELEGRAM_API_TIMEOUT_MS = 10_000;
const TELEGRAM_REJECTION_RETRY_CAP_MS = 5_000;
const TELEGRAM_IDENTITY_ATTESTATION_TTL_MS = 5 * 60_000;
export const TELEGRAM_VOICE_MAX_DURATION_SECONDS = 15 * 60;
const TELEGRAM_FILE_FETCH_TIMEOUT_MS = 30_000;

export interface TelegramConnectorLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface TelegramConnectorConfig {
  botToken?: string;
  /** Expected public bot id for the exact credential in `botToken`. */
  botId?: string;
  botUsername?: string;
  webhookSecret?: string;
}

export type TelegramIdentityAttestationFailureReason =
  | "configuration_invalid"
  | "identity_mismatch"
  | "not_configured"
  | "provider_unavailable";

export interface TelegramAttestedBotIdentity {
  botId: string;
  botUsername: string;
}

/**
 * A value-safe identity failure. Its message and reason are safe at transport
 * boundaries; the credential, expected identity, and provider payload are
 * deliberately excluded.
 */
export class TelegramIdentityAttestationError extends ElizaError {
  override readonly name = "TelegramIdentityAttestationError";

  constructor(
    readonly reason: TelegramIdentityAttestationFailureReason,
    readonly retryable: boolean,
  ) {
    super("Telegram bot identity attestation failed", {
      code: "TELEGRAM_IDENTITY_ATTESTATION_FAILED",
      context: { reason, retryable },
      severity: retryable ? "ephemeral" : "fatal",
    });
  }
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
  groupInvocation?: "mention" | "command" | "reply" | "ambient";
  groupActorRole?: "creator" | "administrator" | "member" | "unknown";
  membershipChange?: "joined" | "removed";
  replyToMessageId?: string;
  providerThreadId?: string;
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

export interface TelegramReplyDeliveryHooks {
  prepare(chunks: readonly string[]): Promise<void>;
  shouldSend(chunkIndex: number, chunk: string): Promise<boolean>;
  deliveredProviderMessageId?(
    chunkIndex: number,
    chunk: string,
  ): Promise<string | null>;
  accepted(
    chunkIndex: number,
    chunk: string,
    providerMessageId: string,
  ): Promise<void>;
  rejected(chunkIndex: number, chunk: string): Promise<void>;
}

export interface TelegramResolvedVoiceNote {
  bytesBase64: string;
  mimeType: "audio/ogg";
  filename: string;
  sizeBytes: number;
  durationSeconds: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
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
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  caption_entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>;
  reply_to_message?: {
    message_id?: number;
    from?: { is_bot?: boolean; username?: string };
  };
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
  my_chat_member?: {
    date?: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    new_chat_member?: { status?: string };
  };
}

export interface TelegramGroupPolicy {
  /** Username returned by Bot API getMe, without the leading @. */
  botUsername: string;
  /** Opt-in for privacy-disabled/admin bots that should see ambient traffic. */
  allowAmbient?: boolean;
}

function normalizedTelegramUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function entityText(
  text: string,
  entity: { offset: number; length: number },
): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

const TELEGRAM_COMMAND_TEXT_PREFIX =
  /^\/[a-z0-9_]{1,32}(?:@([a-z0-9_]{5,32}))?(?=$|\s)/i;

function telegramCommandTarget(value: string): string | null {
  return value.match(/@([a-z0-9_]{5,32})$/i)?.[1] ?? null;
}

/**
 * Default group policy: respond only to a command delivered to the bot, an
 * explicit @mention of this bot, or a reply to one of its messages. Ambient
 * replies require an explicit opt-in even if Telegram privacy mode is off.
 */
export function classifyTelegramGroupInvocation(
  message: TelegramMessage,
  text: string,
  policy: TelegramGroupPolicy,
): TelegramConnectorEvent["groupInvocation"] | null {
  const botUsername = normalizedTelegramUsername(policy.botUsername);
  if (!botUsername) return null;
  const entities = message.text ? message.entities : message.caption_entities;
  const validEntities: Array<{ type: string; value: string }> = [];
  for (const entity of entities ?? []) {
    if (
      !Number.isInteger(entity.offset) ||
      !Number.isInteger(entity.length) ||
      entity.offset < 0 ||
      entity.length <= 0 ||
      entity.offset + entity.length > text.length
    ) {
      continue;
    }
    validEntities.push({ type: entity.type, value: entityText(text, entity) });
  }

  const textCommandMatch = text.trim().match(TELEGRAM_COMMAND_TEXT_PREFIX);
  const textCommandTarget = textCommandMatch?.[1];
  if (
    textCommandTarget &&
    normalizedTelegramUsername(textCommandTarget) !== botUsername
  ) {
    return null;
  }
  for (const entity of validEntities) {
    if (entity.type !== "bot_command") continue;
    const target = telegramCommandTarget(entity.value);
    if (target && normalizedTelegramUsername(target) !== botUsername) {
      return null;
    }
  }

  if (
    message.reply_to_message?.from?.is_bot &&
    normalizedTelegramUsername(message.reply_to_message.from.username ?? "") ===
      botUsername
  ) {
    return "reply";
  }
  for (const entity of validEntities) {
    if (
      entity.type === "mention" &&
      normalizedTelegramUsername(entity.value) === botUsername
    ) {
      return "mention";
    }
    if (entity.type === "bot_command") {
      const target = telegramCommandTarget(entity.value);
      if (!target || normalizedTelegramUsername(target) === botUsername) {
        return "command";
      }
    }
  }
  if (textCommandMatch) return "command";
  return policy.allowAmbient ? "ambient" : null;
}

export function isTelegramGroupInvocation(
  message: TelegramMessage,
  text: string,
  policy: TelegramGroupPolicy,
): boolean {
  return classifyTelegramGroupInvocation(message, text, policy) !== null;
}

export class TelegramApiTransportError extends Error {
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
  groupPolicy?: TelegramGroupPolicy,
): TelegramConnectorEvent | null {
  let update: TelegramUpdate;
  try {
    update = JSON.parse(rawBody) as TelegramUpdate;
  } catch {
    // error-policy:J3 provider webhook JSON is untrusted input.
    logger?.warn("Failed to parse Telegram webhook payload");
    return null;
  }

  const membership = update.my_chat_member;
  if (
    membership &&
    (membership.chat.type === "group" || membership.chat.type === "supergroup")
  ) {
    const status = membership.new_chat_member?.status;
    const membershipChange =
      status === "member" || status === "administrator"
        ? "joined"
        : status === "left" || status === "kicked"
          ? "removed"
          : null;
    if (!membershipChange) return null;
    return {
      platform: "telegram",
      messageId: String(update.update_id),
      platformRecordId: String(update.update_id),
      chatId: String(membership.chat.id),
      chatType: membership.chat.type,
      senderId: String(membership.from?.id ?? membership.chat.id),
      senderName: membership.from?.first_name,
      text: "",
      isCommand: false,
      membershipChange,
      ...(typeof membership.date === "number" &&
      Number.isInteger(membership.date) &&
      membership.date > 0
        ? { providerSentAtMs: membership.date * 1_000 }
        : {}),
      rawPayload: update,
    };
  }

  const message = update.message;
  if (!message) return null;
  const isPrivate = message.chat.type === "private";
  const isGroup =
    message.chat.type === "group" || message.chat.type === "supergroup";
  if (!isPrivate && !isGroup) return null;
  const providerThreadId =
    message.message_thread_id === undefined
      ? undefined
      : Number.isSafeInteger(message.message_thread_id) &&
          message.message_thread_id > 0
        ? String(message.message_thread_id)
        : null;
  if (providerThreadId === null) {
    logger?.warn("Rejected invalid Telegram message thread identifier");
    return null;
  }
  const text = message.text || message.caption || "";
  const voice = message.voice;
  if (!text && !voice) return null;
  if (message.from?.is_bot) return null;
  const groupInvocation =
    isGroup && groupPolicy
      ? classifyTelegramGroupInvocation(message, text, groupPolicy)
      : null;
  if (isGroup && !groupInvocation) {
    return null;
  }

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
    ...(groupInvocation ? { groupInvocation } : {}),
    ...(Number.isInteger(message.reply_to_message?.message_id)
      ? { replyToMessageId: String(message.reply_to_message?.message_id) }
      : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
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
    throw new TelegramApiTransportError(method);
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

interface CachedTelegramIdentity {
  expiresAt: number;
  identity: TelegramAttestedBotIdentity;
}

const telegramIdentityCache = new Map<string, CachedTelegramIdentity>();
const telegramIdentityPending = new Map<
  string,
  Promise<TelegramAttestedBotIdentity>
>();

function normalizeExpectedTelegramIdentity(config: TelegramConnectorConfig): {
  botToken: string;
  botId: string;
  botUsername: string;
  botUsernameKey: string;
} {
  const botToken = config.botToken?.trim() ?? "";
  const botId = config.botId?.trim() ?? "";
  const botUsername = config.botUsername?.trim().replace(/^@/, "") ?? "";
  const botIdNumber = Number(botId);
  if (!botToken || !botId || !botUsername) {
    throw new TelegramIdentityAttestationError("not_configured", false);
  }
  if (
    !/^[1-9]\d{0,15}$/.test(botId) ||
    !Number.isSafeInteger(botIdNumber) ||
    botIdNumber > 4_503_599_627_370_495 ||
    !/^[A-Za-z0-9_]{5,32}$/.test(botUsername) ||
    !botUsername.toLowerCase().endsWith("bot")
  ) {
    throw new TelegramIdentityAttestationError("configuration_invalid", false);
  }
  const tokenBotId = botToken.match(/^([1-9]\d{0,15}):\S+$/)?.[1];
  if (tokenBotId !== botId) {
    throw new TelegramIdentityAttestationError("identity_mismatch", false);
  }
  return {
    botToken,
    botId,
    botUsername,
    botUsernameKey: botUsername.toLowerCase(),
  };
}

/**
 * Proves that the exact outbound credential belongs to the selected public bot.
 * Successful results are cached briefly per credential and expected identity;
 * failures are never cached, so an operator repair can recover immediately.
 */
export async function attestTelegramBotIdentity(
  config: TelegramConnectorConfig,
): Promise<TelegramAttestedBotIdentity> {
  const expected = normalizeExpectedTelegramIdentity(config);
  const cacheKey = `${expected.botToken}\0${expected.botId}\0${expected.botUsernameKey}`;
  const cached = telegramIdentityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  telegramIdentityCache.delete(cacheKey);

  let pending = telegramIdentityPending.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      let me: { id?: unknown; is_bot?: unknown; username?: unknown };
      try {
        me = await telegramApi<{
          id?: unknown;
          is_bot?: unknown;
          username?: unknown;
        }>(expected.botToken, "getMe");
      } catch {
        // error-policy:J1 the provider boundary exposes only a value-safe
        // attestation classification and discards credential-bearing causes.
        throw new TelegramIdentityAttestationError(
          "provider_unavailable",
          true,
        );
      }
      const providerBotId =
        typeof me.id === "number" && Number.isSafeInteger(me.id) && me.id > 0
          ? String(me.id)
          : "";
      const providerUsername =
        typeof me.username === "string"
          ? me.username.trim().replace(/^@/, "")
          : "";
      if (
        me.is_bot !== true ||
        !providerBotId ||
        !/^[A-Za-z0-9_]{5,32}$/.test(providerUsername)
      ) {
        throw new TelegramIdentityAttestationError(
          "provider_unavailable",
          true,
        );
      }
      if (
        providerBotId !== expected.botId ||
        providerUsername.toLowerCase() !== expected.botUsernameKey
      ) {
        throw new TelegramIdentityAttestationError("identity_mismatch", false);
      }
      const identity = {
        botId: expected.botId,
        botUsername: expected.botUsername,
      } satisfies TelegramAttestedBotIdentity;
      telegramIdentityCache.set(cacheKey, {
        expiresAt: Date.now() + TELEGRAM_IDENTITY_ATTESTATION_TTL_MS,
        identity,
      });
      return identity;
    })().finally(() => {
      telegramIdentityPending.delete(cacheKey);
    });
    telegramIdentityPending.set(cacheKey, pending);
  }
  return pending;
}

/** Test-only cache reset; production callers never need to invalidate by value. */
export function __resetTelegramIdentityAttestationCacheForTests(): void {
  telegramIdentityCache.clear();
  telegramIdentityPending.clear();
}

const telegramBotUsernameCache = new Map<string, Promise<string>>();

/** Resolve this credential's public username without exposing the token. */
export async function resolveTelegramBotUsername(
  config: TelegramConnectorConfig,
): Promise<string> {
  const configured = config.botUsername?.trim().replace(/^@/, "");
  if (config.botId) {
    return (await attestTelegramBotIdentity(config)).botUsername;
  }
  if (configured) return configured;
  const botToken = config.botToken;
  if (!botToken) return "";
  let pending = telegramBotUsernameCache.get(botToken);
  if (!pending) {
    pending = telegramApi<{ username?: unknown }>(botToken, "getMe")
      .then((me) => (typeof me.username === "string" ? me.username.trim() : ""))
      .catch((error) => {
        telegramBotUsernameCache.delete(botToken);
        throw error;
      });
    telegramBotUsernameCache.set(botToken, pending);
  }
  return pending;
}

/** Verify the sender's current group authority using Telegram's Bot API. */
export async function resolveTelegramGroupActorRole(
  config: TelegramConnectorConfig,
  chatId: string,
  userId: string,
): Promise<"creator" | "administrator" | "member" | "unknown"> {
  if (!config.botToken) return "unknown";
  const member = await telegramApi<{ status?: unknown }>(
    config.botToken,
    "getChatMember",
    { chat_id: chatId, user_id: userId },
  );
  return member.status === "creator"
    ? "creator"
    : member.status === "administrator"
      ? "administrator"
      : member.status === "member" || member.status === "restricted"
        ? "member"
        : "unknown";
}

function assertValidTelegramChunkLength(maxLength: number): void {
  if (
    !Number.isFinite(maxLength) ||
    !Number.isInteger(maxLength) ||
    maxLength < 2
  ) {
    throw new RangeError(
      "maxLength must be a finite integer of at least 2 UTF-16 code units",
    );
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `text.slice(0, maxLength)` that never ends on the lead half of a surrogate
 * pair. Combined with {@link assertValidTelegramChunkLength}, the chunk loop
 * always consumes at least one code unit.
 */
function truncateWellFormedTelegram(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const end =
    isHighSurrogate(text.charCodeAt(maxLength - 1)) &&
    isLowSurrogate(text.charCodeAt(maxLength))
      ? maxLength - 1
      : maxLength;
  return text.slice(0, end);
}

export function splitTelegramMessage(
  text: string,
  maxLength = MAX_MESSAGE_LENGTH,
): string[] {
  assertValidTelegramChunkLength(maxLength);
  if (!text) return [];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const head = truncateWellFormedTelegram(remaining, maxLength);
    if (head.length === 0) {
      throw new RangeError("telegram chunk limit made no UTF-16 progress");
    }
    chunks.push(head);
    remaining = remaining.slice(head.length);
  }
  return chunks;
}

function telegramThreadParams(event: TelegramConnectorEvent): {
  message_thread_id?: number;
} {
  const providerThreadId = event.providerThreadId;
  if (providerThreadId === undefined) return {};
  if (!/^[1-9]\d{0,15}$/.test(providerThreadId)) {
    throw new TypeError("Invalid Telegram provider thread identifier");
  }
  const messageThreadId = Number(providerThreadId);
  if (!Number.isSafeInteger(messageThreadId)) {
    throw new TypeError("Invalid Telegram provider thread identifier");
  }
  return { message_thread_id: messageThreadId };
}

export async function sendTelegramReply(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
  text: string,
  logger?: TelegramConnectorLogger,
  deliveryHooks?: TelegramReplyDeliveryHooks,
): Promise<TelegramDeliveryReceipt> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram reply");
  if (config.botId) await attestTelegramBotIdentity(config);
  const providerMessageIds: string[] = [];
  const chunks = splitTelegramMessage(text);
  const threadParams = telegramThreadParams(event);
  await deliveryHooks?.prepare(chunks);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    let rejectionRetries = 0;
    while (true) {
      if (
        deliveryHooks &&
        !(await deliveryHooks.shouldSend(chunkIndex, chunk))
      ) {
        const priorProviderMessageId =
          await deliveryHooks.deliveredProviderMessageId?.(chunkIndex, chunk);
        if (priorProviderMessageId) {
          providerMessageIds.push(priorProviderMessageId);
        }
        break;
      }
      try {
        let message: TelegramMessage;
        try {
          message = await telegramApi<TelegramMessage>(
            config.botToken,
            "sendMessage",
            {
              chat_id: event.chatId,
              ...threadParams,
              text: chunk,
              parse_mode: "Markdown",
            },
          );
        } catch (error) {
          // error-policy:J4 retry without formatting only for Telegram's exact parse rejection.
          if (
            !(error instanceof TelegramApiResponseError) ||
            !isMarkdownFormattingRejection(error)
          ) {
            throw error;
          }
          logger?.warn(
            "Telegram sendMessage failed, retrying without Markdown",
            { error: error.message },
          );
          message = await telegramApi<TelegramMessage>(
            config.botToken,
            "sendMessage",
            { chat_id: event.chatId, ...threadParams, text: chunk },
          );
        }
        const providerMessageId = String(message.message_id);
        await deliveryHooks?.accepted(chunkIndex, chunk, providerMessageId);
        providerMessageIds.push(providerMessageId);
        break;
      } catch (error) {
        // error-policy:J1 translate typed provider rejection at the delivery boundary.
        if (!(error instanceof TelegramApiResponseError)) throw error;
        await deliveryHooks?.rejected(chunkIndex, chunk);
        if (
          !deliveryHooks ||
          error.errorCode !== 429 ||
          rejectionRetries >= 1 ||
          error.retryAfterSeconds === undefined
        ) {
          throw error;
        }
        const retryAfterSeconds = error.retryAfterSeconds;
        rejectionRetries += 1;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              retryAfterSeconds * 1_000,
              TELEGRAM_REJECTION_RETRY_CAP_MS,
            ),
          ),
        );
      }
    }
  }
  return { providerMessageIds };
}

export async function sendTelegramTyping(
  config: TelegramConnectorConfig,
  event: TelegramConnectorEvent,
): Promise<void> {
  if (!config.botToken) throw new Error("Missing botToken for Telegram typing");
  if (config.botId) await attestTelegramBotIdentity(config);
  await telegramApi(config.botToken, "sendChatAction", {
    chat_id: event.chatId,
    ...telegramThreadParams(event),
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
