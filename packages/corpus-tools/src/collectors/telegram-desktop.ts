/**
 * Official Telegram Desktop JSON-export collector. It accepts only a bounded
 * local `result.json`, never Telegram credentials or sessions, and converts
 * owner DMs plus explicitly allowlisted groups/channels into deterministic
 * monthly corpus shards. Export structure, identifiers, counts, and output
 * paths are validated before use; media paths are never opened and attachment
 * hashes are never inferred from export metadata.
 */
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import {
  CORPUS_ANCHOR_ISO,
  CORPUS_ANCHOR_MS,
  CORPUS_CUTOFF_MS,
  type CorpusManifest,
  type CorpusMessage,
  corpusMessageSchema,
} from "../schema.ts";
import {
  buildCorpusManifest,
  type CorpusValidationIssue,
} from "../validator.ts";
import {
  readTelegramDesktopJson,
  type TelegramShardWriteStats,
  withTelegramOutputLock,
  writeTelegramArtifact,
  writeTelegramShards,
} from "./telegram-desktop-io.ts";

export type { TelegramShardWriteStats } from "./telegram-desktop-io.ts";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHATS = 100_000;
const MAX_MAX_CHATS = 250_000;
const DEFAULT_MAX_MESSAGES = 5_000_000;
const MAX_MAX_MESSAGES = 10_000_000;
const MAX_TEXT_PARTS = 100_000;

const DM_TYPES = new Set([
  "saved_messages",
  "replies",
  "personal_chat",
  "bot_chat",
]);
const CREDENTIAL_TYPES = new Set(["verification_codes"]);
const GROUP_TYPES = new Set([
  "private_group",
  "private_supergroup",
  "public_supergroup",
  // Older exports used this spelling before supergroups were distinguished.
  "public_group",
]);
const CHANNEL_TYPES = new Set(["private_channel", "public_channel"]);
const SECRET_TYPES = new Set(["secret_chat", "encrypted_chat"]);
const DELETED_MESSAGE_TYPES = new Set(["deleted", "deleted_message"]);

const MEDIA_KEYS = new Set([
  "photo",
  "file",
  "media_type",
  "contact_information",
  "contact_vcard",
  "location_information",
  "place_name",
  "game_title",
  "invoice_information",
  "poll",
  "giveaway_information",
  "story_id",
]);

type TelegramPeerKind = "dm" | "group" | "channel";

export interface TelegramDesktopCollectorOptions {
  /** Path to Telegram Desktop's machine-readable `result.json`. */
  exportPath: string;
  /** Expected owner user id; collection fails if the export belongs to another account. */
  ownerAccountId: string;
  /** Optional owner display override used for outbound rows. */
  ownerDisplay?: string;
  /** Root under which `telegram/<owner>/<yyyy-mm>.jsonl` is written. */
  outDir: string;
  /** Group ids admitted into the corpus. Groups are denied when omitted. */
  allowedGroupPeerIds?: readonly string[];
  /** Channel ids admitted into the corpus. Channels are denied when omitted. */
  allowedChannelPeerIds?: readonly string[];
  /** Input safety bound, configurable only up to the 64 MiB parse ceiling. */
  maxInputBytes?: number;
  /** Chat-count safety bound. */
  maxChats?: number;
  /** Aggregate message-record safety bound. */
  maxMessages?: number;
}

export interface TelegramPeerClassCounts {
  dm: number;
  group: number;
  channel: number;
}

/** Stable, privacy-safe aggregate written beside the local corpus. */
export interface TelegramDesktopSummary {
  schemaVersion: 1;
  peerCounts: TelegramPeerClassCounts;
  messageCounts: TelegramPeerClassCounts;
  deniedGroupChats: number;
  deniedGroupMessages: number;
  deniedChannelChats: number;
  deniedChannelMessages: number;
  unsupportedSecretChats: number;
  unsupportedSecretMessages: number;
  unsupportedCredentialChats: number;
  unsupportedCredentialMessages: number;
  unsupportedMessages: number;
  unsupportedDeletedMessages: number;
  unsupportedServiceMessages: number;
  unsupportedMediaOnlyMessages: number;
  skippedBeforeCutoff: number;
  skippedAfterAnchor: number;
  shardCount: number;
}

export interface TelegramDesktopCollectResult {
  summary: TelegramDesktopSummary;
  writeStats: TelegramShardWriteStats;
  manifest: CorpusManifest;
  issues: CorpusValidationIssue[];
  shardPaths: string[];
}

interface CandidateMessage {
  message: CorpusMessage;
  rawMessageId: string;
  rawReplyToId?: string;
  replyTargetsSamePeer: boolean;
}

interface CollectContext {
  ownerAccountId: string;
  ownerSenderId: string;
  ownerDisplay: string;
  allowedGroups: ReadonlySet<string>;
  allowedChannels: ReadonlySet<string>;
  summary: TelegramDesktopSummary;
}

function telegramInputError(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, { code, context, cause });
}

/** Fails closed where private ACL and reparse-point enforcement is unavailable. */
export function assertTelegramDesktopPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  throw telegramInputError(
    "TELEGRAM_EXPORT_UNSUPPORTED_PLATFORM",
    "Telegram Desktop corpus collection is disabled on Windows until output reparse-point rejection and owner-only ACL enforcement are implemented and verified",
    { platform },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  location: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_SHAPE",
      `${location} must be an object`,
      { location },
    );
  }
  return value;
}

function requireArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_SHAPE",
      `${location} must be an array`,
      { location },
    );
  }
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_SHAPE",
      `${location} must be a non-empty string`,
      { location },
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function canonicalIntegerId(value: unknown, location: string): string {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : undefined;
  if (!text || !/^[1-9]\d{0,18}$/.test(text)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_ID",
      `${location} must be a canonical positive integer id`,
      { location },
    );
  }
  return text;
}

/**
 * Telegram Desktop exports migrated basic-group history with negative message
 * ids (the desktop client shifts them by -1,000,000,000). Message and reply
 * ids therefore accept canonical signed non-zero integers; account, peer, and
 * allowlist identities remain positive-only at their existing boundary.
 */
function canonicalMessageId(value: unknown, location: string): string {
  const text =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : undefined;
  if (!text || !/^-?(?:[1-9]\d{0,18})$/.test(text)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_ID",
      `${location} must be a canonical non-zero signed integer message id`,
      { location },
    );
  }
  return text;
}

function canonicalOwnerId(value: unknown, location: string): string {
  const id = canonicalIntegerId(value, location);
  return id;
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
  name: string,
): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > ceiling) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_LIMIT",
      `${name} must be a positive integer no greater than ${ceiling}`,
      { name, ceiling },
    );
  }
  return bound;
}

function canonicalAllowlist(
  values: readonly string[] | undefined,
  location: string,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const [index, value] of (values ?? []).entries()) {
    const id = canonicalIntegerId(value, `${location}[${index}]`);
    if (result.has(id)) {
      throw telegramInputError(
        "TELEGRAM_EXPORT_BAD_ALLOWLIST",
        `${location} contains duplicate id ${id}`,
        { location },
      );
    }
    result.add(id);
  }
  return result;
}

function classifyChat(
  type: string,
): TelegramPeerKind | "secret" | "credential" {
  if (DM_TYPES.has(type)) return "dm";
  if (CREDENTIAL_TYPES.has(type)) return "credential";
  if (GROUP_TYPES.has(type)) return "group";
  if (CHANNEL_TYPES.has(type)) return "channel";
  if (SECRET_TYPES.has(type)) return "secret";
  throw telegramInputError(
    "TELEGRAM_EXPORT_UNSUPPORTED_CHAT_TYPE",
    `unsupported Telegram chat type ${type}`,
    { type },
  );
}

function parseUnixTimestamp(value: unknown, location: string): number {
  const seconds =
    typeof value === "string" && /^(0|[1-9]\d{0,11})$/.test(value)
      ? Number(value)
      : typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : Number.NaN;
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_TIMESTAMP",
      `${location} must be a Unix timestamp in whole seconds`,
      { location },
    );
  }
  return milliseconds;
}

function parseText(value: unknown, location: string): string {
  if (typeof value === "string") return value;
  const parts = requireArray(value, location);
  if (parts.length > MAX_TEXT_PARTS) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_COUNT_LIMIT",
      `${location} exceeds the rich-text part limit`,
      { location, limit: MAX_TEXT_PARTS },
    );
  }
  return parts
    .map((part, index) => {
      if (typeof part === "string") return part;
      const record = requireRecord(part, `${location}[${index}]`);
      if (typeof record.text !== "string") {
        throw telegramInputError(
          "TELEGRAM_EXPORT_BAD_SHAPE",
          `${location}[${index}].text must be a string`,
          { location: `${location}[${index}].text` },
        );
      }
      return record.text;
    })
    .join("");
}

function hasMedia(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => MEDIA_KEYS.has(key));
}

function parseSenderId(value: unknown, location: string): string {
  const id = requireString(value, location);
  if (!/^(user|chat|channel)[1-9]\d{0,18}$/.test(id)) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_BAD_ID",
      `${location} must be an exported Telegram peer id`,
      { location },
    );
  }
  return id;
}

function monthOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function compoundId(
  accountId: string,
  kind: TelegramPeerKind,
  peerId: string,
  messageId?: string,
): string {
  const peer = `telegram:${accountId}:${kind}:${peerId}`;
  return messageId ? `${peer}:${messageId}` : peer;
}

function sameReplyPeer(
  value: unknown,
  kind: TelegramPeerKind,
  peerId: string,
): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const prefix =
    kind === "channel" ? "channel" : kind === "group" ? "chat" : "user";
  return value === `${prefix}${peerId}`;
}

function mapChatMessages(
  kind: TelegramPeerKind,
  peerId: string,
  peerDisplay: string | undefined,
  messages: unknown[],
  chatLocation: string,
  ctx: CollectContext,
): CorpusMessage[] {
  const candidates: CandidateMessage[] = [];
  const rawIds = new Set<string>();

  for (const [index, value] of messages.entries()) {
    const location = `${chatLocation}.messages[${index}]`;
    const record = requireRecord(value, location);
    const rawMessageId = canonicalMessageId(record.id, `${location}.id`);
    if (rawIds.has(rawMessageId)) {
      throw telegramInputError(
        "TELEGRAM_EXPORT_DUPLICATE_MESSAGE",
        `${chatLocation} contains duplicate message id ${rawMessageId}`,
        { chatLocation },
      );
    }
    rawIds.add(rawMessageId);

    const type = requireString(record.type, `${location}.type`);
    if (type === "service") {
      ctx.summary.unsupportedServiceMessages += 1;
      continue;
    }
    if (DELETED_MESSAGE_TYPES.has(type) || record.deleted === true) {
      ctx.summary.unsupportedDeletedMessages += 1;
      continue;
    }
    if (type === "unsupported") {
      ctx.summary.unsupportedMessages += 1;
      continue;
    }
    if (type !== "message") {
      throw telegramInputError(
        "TELEGRAM_EXPORT_UNSUPPORTED_MESSAGE_TYPE",
        `${location}.type has unsupported value ${type}`,
        { location, type },
      );
    }

    const text = parseText(record.text, `${location}.text`);
    if (text.trim().length === 0) {
      if (hasMedia(record)) {
        ctx.summary.unsupportedMediaOnlyMessages += 1;
        continue;
      }
      throw telegramInputError(
        "TELEGRAM_EXPORT_EMPTY_MESSAGE",
        `${location} has neither text nor recognized media`,
        { location },
      );
    }

    const ts = parseUnixTimestamp(
      record.date_unixtime,
      `${location}.date_unixtime`,
    );
    if (ts < CORPUS_CUTOFF_MS) {
      ctx.summary.skippedBeforeCutoff += 1;
      continue;
    }
    if (ts > CORPUS_ANCHOR_MS) {
      ctx.summary.skippedAfterAnchor += 1;
      continue;
    }

    const senderId =
      record.from_id === undefined && kind === "channel"
        ? `channel${peerId}`
        : parseSenderId(record.from_id, `${location}.from_id`);
    const outbound = senderId === ctx.ownerSenderId;
    const rawReplyToId =
      record.reply_to_message_id === undefined
        ? undefined
        : canonicalMessageId(
            record.reply_to_message_id,
            `${location}.reply_to_message_id`,
          );
    const message = corpusMessageSchema.parse({
      id: compoundId(ctx.ownerAccountId, kind, peerId, rawMessageId),
      platform: "telegram",
      accountId: ctx.ownerAccountId,
      threadId: compoundId(ctx.ownerAccountId, kind, peerId),
      ts,
      direction: outbound ? "out" : "in",
      senderId,
      senderDisplay: outbound
        ? ctx.ownerDisplay
        : (optionalString(record.from) ??
          optionalString(record.author) ??
          peerDisplay ??
          senderId),
      recipients:
        kind === "dm"
          ? [
              {
                id: outbound ? `telegram:${kind}:${peerId}` : ctx.ownerSenderId,
              },
            ]
          : [],
      text,
      labels: [`telegram:${kind}`],
      // Telegram result.json contains paths and byte counts, not content hashes.
      // The collector deliberately does not open those untrusted paths.
      attachments: [],
      scrubState: "raw",
    });
    candidates.push({
      message,
      rawMessageId,
      rawReplyToId,
      replyTargetsSamePeer: sameReplyPeer(
        record.reply_to_peer_id,
        kind,
        peerId,
      ),
    });
  }

  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.rawMessageId, candidate]),
  );
  return candidates.map((candidate) => {
    if (!candidate.rawReplyToId || !candidate.replyTargetsSamePeer) {
      return candidate.message;
    }
    const parent = candidatesById.get(candidate.rawReplyToId);
    if (
      !parent ||
      monthOf(parent.message.ts) !== monthOf(candidate.message.ts)
    ) {
      return candidate.message;
    }
    return corpusMessageSchema.parse({
      ...candidate.message,
      replyToId: parent.message.id,
    });
  });
}

function countMessages(
  messages: unknown[],
  current: number,
  limit: number,
): number {
  const next = current + messages.length;
  if (!Number.isSafeInteger(next) || next > limit) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_COUNT_LIMIT",
      `Telegram export exceeds the aggregate message limit ${limit}`,
      { limit },
    );
  }
  return next;
}

function initialSummary(): TelegramDesktopSummary {
  return {
    schemaVersion: 1,
    peerCounts: { dm: 0, group: 0, channel: 0 },
    messageCounts: { dm: 0, group: 0, channel: 0 },
    deniedGroupChats: 0,
    deniedGroupMessages: 0,
    deniedChannelChats: 0,
    deniedChannelMessages: 0,
    unsupportedSecretChats: 0,
    unsupportedSecretMessages: 0,
    unsupportedCredentialChats: 0,
    unsupportedCredentialMessages: 0,
    unsupportedMessages: 0,
    unsupportedDeletedMessages: 0,
    unsupportedServiceMessages: 0,
    unsupportedMediaOnlyMessages: 0,
    skippedBeforeCutoff: 0,
    skippedAfterAnchor: 0,
    shardCount: 0,
  };
}

/**
 * Collects an official Telegram Desktop `result.json` into canonical local
 * corpus shards. The function is deliberately offline and accepts no GramJS
 * client, StringSession, API credentials, or archive-contained output paths.
 */
export async function collectTelegramDesktopExport(
  options: TelegramDesktopCollectorOptions,
): Promise<TelegramDesktopCollectResult> {
  assertTelegramDesktopPlatformSupported();
  const ownerAccountId = canonicalOwnerId(
    options.ownerAccountId,
    "ownerAccountId",
  );
  const maxInputBytes = positiveBound(
    options.maxInputBytes,
    DEFAULT_MAX_INPUT_BYTES,
    MAX_MAX_INPUT_BYTES,
    "maxInputBytes",
  );
  const maxChats = positiveBound(
    options.maxChats,
    DEFAULT_MAX_CHATS,
    MAX_MAX_CHATS,
    "maxChats",
  );
  const maxMessages = positiveBound(
    options.maxMessages,
    DEFAULT_MAX_MESSAGES,
    MAX_MAX_MESSAGES,
    "maxMessages",
  );
  const input = requireRecord(
    await readTelegramDesktopJson(options.exportPath, maxInputBytes),
    "result.json",
  );
  const personal = requireRecord(
    input.personal_information,
    "result.json.personal_information",
  );
  const exportedOwnerId = canonicalOwnerId(
    personal.user_id,
    "result.json.personal_information.user_id",
  );
  if (exportedOwnerId !== ownerAccountId) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_OWNER_MISMATCH",
      "Telegram Desktop export belongs to a different account",
    );
  }

  const chats = requireArray(
    requireRecord(input.chats, "result.json.chats").list,
    "result.json.chats.list",
  );
  const leftChats =
    input.left_chats === undefined
      ? []
      : requireArray(
          requireRecord(input.left_chats, "result.json.left_chats").list,
          "result.json.left_chats.list",
        );
  const chatCount = chats.length + leftChats.length;
  if (!Number.isSafeInteger(chatCount) || chatCount > maxChats) {
    throw telegramInputError(
      "TELEGRAM_EXPORT_COUNT_LIMIT",
      `Telegram export exceeds the chat limit ${maxChats}`,
      { maxChats },
    );
  }
  const allChats = [...chats, ...leftChats];

  const firstName = optionalString(personal.first_name);
  const lastName = optionalString(personal.last_name);
  const exportedOwnerDisplay = [firstName, lastName].filter(Boolean).join(" ");
  const ownerDisplay =
    optionalString(options.ownerDisplay) ||
    optionalString(exportedOwnerDisplay) ||
    ownerAccountId;
  const ctx: CollectContext = {
    ownerAccountId,
    ownerSenderId: `user${ownerAccountId}`,
    ownerDisplay,
    allowedGroups: canonicalAllowlist(
      options.allowedGroupPeerIds,
      "allowedGroupPeerIds",
    ),
    allowedChannels: canonicalAllowlist(
      options.allowedChannelPeerIds,
      "allowedChannelPeerIds",
    ),
    summary: initialSummary(),
  };

  const peerKeys = new Set<string>();
  const normalized: CorpusMessage[] = [];
  let seenMessages = 0;
  for (const [index, value] of allChats.entries()) {
    const location = `result.json.${index < chats.length ? "chats" : "left_chats"}.list[${index < chats.length ? index : index - chats.length}]`;
    const chat = requireRecord(value, location);
    const type = requireString(chat.type, `${location}.type`);
    const kind = classifyChat(type);
    const peerId = canonicalIntegerId(chat.id, `${location}.id`);
    const messages = requireArray(chat.messages, `${location}.messages`);
    seenMessages = countMessages(messages, seenMessages, maxMessages);
    const peerKey = `${kind}:${peerId}`;
    if (peerKeys.has(peerKey)) {
      throw telegramInputError(
        "TELEGRAM_EXPORT_DUPLICATE_CHAT",
        `Telegram export repeats peer ${peerKey}`,
      );
    }
    peerKeys.add(peerKey);

    if (kind === "secret") {
      ctx.summary.unsupportedSecretChats += 1;
      ctx.summary.unsupportedSecretMessages += messages.length;
      continue;
    }
    if (kind === "credential") {
      ctx.summary.unsupportedCredentialChats += 1;
      ctx.summary.unsupportedCredentialMessages += messages.length;
      continue;
    }
    if (kind === "group" && !ctx.allowedGroups.has(peerId)) {
      ctx.summary.deniedGroupChats += 1;
      ctx.summary.deniedGroupMessages += messages.length;
      continue;
    }
    if (kind === "channel" && !ctx.allowedChannels.has(peerId)) {
      ctx.summary.deniedChannelChats += 1;
      ctx.summary.deniedChannelMessages += messages.length;
      continue;
    }

    ctx.summary.peerCounts[kind] += 1;
    const mapped = mapChatMessages(
      kind,
      peerId,
      optionalString(chat.name),
      messages,
      location,
      ctx,
    );
    ctx.summary.messageCounts[kind] += mapped.length;
    normalized.push(...mapped);
  }

  return withTelegramOutputLock(options.outDir, async (assertRootIdentity) => {
    await assertRootIdentity();
    const { paths: shardPaths, stats: writeStats } = await writeTelegramShards(
      normalized,
      options.outDir,
      ownerAccountId,
    );
    await assertRootIdentity();
    ctx.summary.shardCount = shardPaths.length;
    const { manifest, issues } = await buildCorpusManifest(
      options.outDir,
      CORPUS_ANCHOR_ISO,
    );
    await assertRootIdentity();
    if (issues.length > 0) {
      throw telegramInputError(
        "TELEGRAM_EXPORT_MANIFEST_INVALID",
        "Telegram output failed corpus manifest validation",
        { issueCount: issues.length, issues },
      );
    }
    await writeTelegramArtifact(
      path.join(options.outDir, "telegram", ownerAccountId, "summary.json"),
      `${JSON.stringify(ctx.summary, null, 2)}\n`,
      assertRootIdentity,
    );
    await assertRootIdentity();
    // The manifest is the generation commit marker and is installed last.
    await writeTelegramArtifact(
      path.join(options.outDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      assertRootIdentity,
    );
    await assertRootIdentity();
    return { summary: ctx.summary, writeStats, manifest, issues, shardPaths };
  });
}
