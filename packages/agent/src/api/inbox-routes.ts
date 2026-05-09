/**
 * Inbox routes.
 *
 * Exposes a read-only, time-ordered view of messages from every channel
 * the agent participates in — dashboard web chat plus every connector
 * plugin (iMessage, Telegram, Discord, WhatsApp, WeChat, etc.) — merged
 * into a single feed so the UI can render an inbox without the
 * client having to know which rooms each source uses.
 *
 * Why a separate endpoint instead of reusing /api/conversations/:id/messages:
 *
 *   Each connector plugin creates its own rooms keyed by the external
 *   chat id (chat.db chat_identifier for iMessage, chat_id for Telegram,
 *   etc.). The dashboard conversation room is pinned to
 *   `${agentName}-web-chat-room`. A single-room read path can't see
 *   cross-channel traffic, and we don't want to fan out writes to the
 *   web-chat room on every connector dispatch (it would pollute the
 *   dashboard world with entities that don't belong to it and break
 *   the "one conversation = one room" invariant that bootstrap relies
 *   on). The read-side aggregator keeps each connector's world/room
 *   graph intact while still giving the UI a combined feed.
 *
 * Routes:
 *
 *   GET /api/inbox/messages?limit=N&sources=imessage,telegram
 *     Returns the N most recent messages across all agent rooms where
 *     `content.source` is set to a connector tag. `sources` (optional,
 *     comma-separated) filters to a specific subset. Ordered newest
 *     first. Default limit is 100, hard cap 500.
 *
 *   GET /api/inbox/sources
 *     Returns the distinct set of source tags the agent currently has
 *     memories for, so the UI can render a dynamic source filter chip
 *     list without hardcoding connector names.
 */

import type http from "node:http";
import type {
  AgentRuntime,
  Memory,
  Room,
  RouteHelpers,
  UUID,
  World,
} from "@elizaos/core";
import { cacheDiscordAvatarUrl } from "@elizaos/plugin-discord";
import {
  expandConnectorSourceFilter,
  normalizeConnectorSource,
} from "@elizaos/shared";

/**
 * Source tags we consider "inbox-worthy". Messages whose content.source
 * is none of these are excluded from the combined feed — this keeps
 * internal sources (e.g. system events, knowledge ingestion, trajectory
 * markers) out of the user-facing inbox.
 *
 * `client_chat` is intentionally excluded; those are dashboard turns and
 * are already visible in the conversation view. The inbox is for
 * *inbound* messages from other humans via connector channels.
 */
const DEFAULT_INBOX_SOURCE_FILTER = [
  "imessage",
  "telegram",
  "discord",
  "whatsapp",
  "wechat",
  "slack",
  "signal",
  "sms",
] as const;

const DEFAULT_INBOX_SOURCES = expandConnectorSourceFilter(
  DEFAULT_INBOX_SOURCE_FILTER,
);

/**
 * Hard ceiling on the number of rooms we scan per request. Large
 * deployments can accumulate hundreds of connector rooms; scanning all
 * of them on every request would make the endpoint scale quadratically
 * with history. 2000 rooms covers heavy deployments and leaves headroom
 * for internal worlds (autonomy/self-talk) without crowding out real
 * connector channels.
 */
const MAX_ROOMS_SCANNED = 2000;
const ORPHAN_ROOM_MEMORY_SCAN_LIMIT = 10_000;

/**
 * Worlds we never want to surface in the connector chats sidebar. These
 * are internal scratch worlds (autonomy-service self-talk, advanced
 * memory, relationships graph) that contain hundreds of synthetic rooms
 * the user never interacts with directly. Including them used to consume
 * the entire room-scan budget and drown out real connector channels.
 */
const INTERNAL_WORLD_IDS = new Set<string>([
  "00000000-0000-0000-0000-000000000001", // Autonomy World
]);
const INTERNAL_WORLD_NAME_MARKERS = [
  "advanced memory",
  "relationships world",
  "autonomy world",
];

function isInternalWorld(world: { id?: string; name?: string }): boolean {
  if (world.id && INTERNAL_WORLD_IDS.has(world.id.toLowerCase())) return true;
  const name = world.name?.toLowerCase().trim();
  if (!name) return false;
  return INTERNAL_WORLD_NAME_MARKERS.some((marker) => name === marker);
}

/**
 * How many memories we ask the database for per room. We over-fetch
 * slightly so that after filtering by source tag we still have enough
 * to fill `limit` for the caller. If a room has 500 messages but only
 * the most recent 50 are connector messages, we'd miss them with a
 * tight per-room limit. 3x the requested limit is a reasonable margin.
 */
const PER_ROOM_OVERFETCH_MULTIPLIER = 3;

export interface InboxRouteState {
  runtime: AgentRuntime | null;
}

/**
 * A single message in the inbox response. Shape mirrors
 * ConversationMessage on the client (see packages/app-core/src/api/
 * client-types-chat.ts) so ChatView can render the same component for
 * both feeds without a type dance.
 */
interface InboxMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  source: string;
  /** External chat room id (for threading / jump-to-conversation links). */
  roomId: string;
  /** Best-effort display name of the sender entity, if available. */
  from?: string;
  /** Best-effort username/handle of the sender entity, if available. */
  fromUserName?: string;
  /** Sender avatar URL when the connector can provide one. */
  avatarUrl?: string;
  /** Internal message id this message replies to, when available. */
  replyToMessageId?: string;
  /** Best-effort display name of the replied-to sender. */
  replyToSenderName?: string;
  /** Best-effort username/handle of the replied-to sender. */
  replyToSenderUserName?: string;
  /** Aggregated reactions attached to this message. */
  reactions?: InboxReaction[];
}

interface InboxReaction {
  emoji: string;
  count: number;
  users?: string[];
}

type InboxMessageRecord = InboxMessage & {
  hasExternalUrl: boolean;
  hasExplicitSource: boolean;
  rawDiscordChannelId?: string;
  rawDiscordMessageId?: string;
  rawReplyToSenderId?: string;
  senderEntityId?: string;
  rawSenderId?: string;
  responseId?: string;
};

type DiscordReactionEvent = {
  action: "add" | "remove";
  emoji: string;
  targetMessageId: string;
  userKey: string;
  userLabel?: string;
};

type ReactionAggregateState = {
  emoji: string;
  users: Map<string, string | undefined>;
};

/**
 * Parse and clamp the `limit` query parameter. Defaults to 100, capped
 * at 500. Non-numeric input is treated as the default.
 */
function parseLimit(raw: string | null): number {
  if (!raw) return 100;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

/**
 * Parse the `sources` query parameter into a Set of lowercase tags, or
 * null to mean "use the default inbox source set".
 */
function parseSourceFilter(raw: string | null): Set<string> | null {
  if (!raw) return null;
  const tags = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tags.length === 0) return null;
  return expandConnectorSourceFilter(tags);
}

function getRuntimeSendHandlers(
  runtime: AgentRuntime,
): Map<string, unknown> | null {
  const sendHandlers = Reflect.get(runtime, "sendHandlers") as unknown;
  return sendHandlers instanceof Map ? sendHandlers : null;
}

function runtimeHasSendHandler(runtime: AgentRuntime, source: string): boolean {
  return getRuntimeSendHandlers(runtime)?.has(source) ?? false;
}

/**
 * Pull the source tag out of a Memory row. Memory.content is typed as
 * `Content` in core but the shape we care about is a loose record with
 * an optional `source?: string` field. Returns null if the source is
 * missing, non-string, or empty.
 */
function extractSource(memory: Memory): string | null {
  const content = memory.content as { source?: unknown } | undefined;
  const source = content?.source;
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isDiscordConnectorSource(source: string | null | undefined): boolean {
  return normalizeConnectorSource(source) === "discord";
}

/**
 * Pull the visible text out of a Memory row. Same rationale as
 * extractSource — we're pulling fields off a loosely-typed Content
 * object and normalizing.
 */
function extractText(memory: Memory): string {
  const content = memory.content as { text?: unknown } | undefined;
  const text = content?.text;
  return typeof text === "string" ? text : "";
}

function extractResponseId(memory: Memory): string | undefined {
  const content = memory.content as { responseId?: unknown } | undefined;
  const responseId = content?.responseId;
  if (typeof responseId === "string" && responseId.length > 0) {
    return responseId;
  }
  return undefined;
}

function extractContentUrl(memory: Memory): string | undefined {
  const content = memory.content as { url?: unknown } | undefined;
  const url = content?.url;
  if (typeof url === "string" && url.length > 0) {
    return url;
  }
  return undefined;
}

/**
 * Best-effort sender display name from memory.metadata.entityName. The
 * bootstrap plugin stamps this when it builds memories from
 * ENTITY_JOINED events; connector plugins should do the same via their
 * lifecycle event payloads (iMessage does — see dispatchInboundMessage
 * in plugin-imessage's service.ts).
 */
function extractFrom(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const entityName = meta?.entityName;
  if (typeof entityName === "string" && entityName.length > 0) {
    return entityName;
  }
  return undefined;
}

function extractFromUserName(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const entityUserName = meta?.entityUserName;
  if (typeof entityUserName === "string" && entityUserName.length > 0) {
    return entityUserName;
  }

  const username = meta?.username;
  if (typeof username === "string" && username.length > 0) {
    return username;
  }
  return undefined;
}

function extractFromAvatarUrl(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const entityAvatarUrl = meta?.entityAvatarUrl;
  if (typeof entityAvatarUrl === "string" && entityAvatarUrl.length > 0) {
    return entityAvatarUrl;
  }
  return undefined;
}

function extractRawSenderId(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const fromId = meta?.fromId;
  if (typeof fromId === "string" && fromId.length > 0) {
    return fromId;
  }
  return undefined;
}

function extractDiscordChannelId(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const discordChannelId = meta?.discordChannelId;
  if (typeof discordChannelId === "string" && discordChannelId.length > 0) {
    return discordChannelId;
  }
  return undefined;
}

function extractDiscordMessageId(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const discordMessageId = meta?.discordMessageId;
  if (typeof discordMessageId === "string" && discordMessageId.length > 0) {
    return discordMessageId;
  }
  return undefined;
}

function readLooseStringValue(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!record) return null;

  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function asLooseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRoomSource(room: Room | undefined): string | null {
  return readLooseStringValue(asLooseRecord(room), ["source"]);
}

function readRoomWorldId(room: Room | undefined): string | undefined {
  return (
    readLooseStringValue(asLooseRecord(room), ["worldId", "world_id"]) ??
    undefined
  );
}

function readRoomServerId(room: Room | undefined): string | undefined {
  return (
    readLooseStringValue(asLooseRecord(room), [
      "serverId",
      "server_id",
      "messageServerId",
      "message_server_id",
    ]) ?? undefined
  );
}

function readRoomType(room: Room | undefined): string | null {
  return readLooseStringValue(asLooseRecord(room), [
    "type",
    "roomType",
    "room_type",
  ]);
}

function readRoomChannelId(room: Room | undefined): string | undefined {
  return (
    readLooseStringValue(asLooseRecord(room), ["channelId", "channel_id"]) ??
    undefined
  );
}

function readRoomCreatedAt(room: Room | undefined): number | undefined {
  const record = asLooseRecord(room);
  const value = record?.createdAt ?? record?.created_at;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readWorldName(world: World | undefined): string | null {
  return readLooseStringValue(asLooseRecord(world), ["name"]);
}

function readWorldServerId(world: World | undefined): string | undefined {
  return (
    readLooseStringValue(asLooseRecord(world), [
      "messageServerId",
      "message_server_id",
      "serverId",
      "server_id",
    ]) ?? undefined
  );
}

function normalizeRoomTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlaceholderConversationTitle(title: string | null): boolean {
  if (!title) return false;
  const normalized = title.trim().toLowerCase();
  return (
    normalized === "default" ||
    normalized === "new chat" ||
    normalized === "discord chat"
  );
}

function equalsNormalizedTitle(
  left: string | null,
  right: string | null,
): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function extractReplyToMessageId(memory: Memory): string | undefined {
  const content = memory.content as { inReplyTo?: unknown } | undefined;
  const inReplyTo = content?.inReplyTo;
  if (typeof inReplyTo === "string" && inReplyTo.length > 0) {
    return inReplyTo;
  }

  const meta = memory.metadata as Record<string, unknown> | undefined;
  const replyToMessageId = meta?.replyToMessageId;
  if (typeof replyToMessageId === "string" && replyToMessageId.length > 0) {
    return replyToMessageId;
  }
  return undefined;
}

function extractReplyAuthorRecord(
  memory: Memory,
): Record<string, unknown> | null {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const replyToAuthor = meta?.replyToAuthor;
  if (!replyToAuthor || typeof replyToAuthor !== "object") {
    return null;
  }
  return replyToAuthor as Record<string, unknown>;
}

function extractReplyToSenderName(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const replyToSenderName = meta?.replyToSenderName;
  if (typeof replyToSenderName === "string" && replyToSenderName.length > 0) {
    return replyToSenderName;
  }

  const replyAuthor = extractReplyAuthorRecord(memory);
  const displayName = replyAuthor?.displayName;
  if (typeof displayName === "string" && displayName.length > 0) {
    return displayName;
  }
  const username = replyAuthor?.username;
  if (typeof username === "string" && username.length > 0) {
    return username;
  }
  return undefined;
}

function extractReplyToSenderUserName(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const replyToSenderUserName = meta?.replyToSenderUserName;
  if (
    typeof replyToSenderUserName === "string" &&
    replyToSenderUserName.length > 0
  ) {
    return replyToSenderUserName;
  }

  const replyAuthor = extractReplyAuthorRecord(memory);
  const username = replyAuthor?.username;
  if (typeof username === "string" && username.length > 0) {
    return username;
  }
  return undefined;
}

function extractReplyToSenderId(memory: Memory): string | undefined {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const replyToSenderId = meta?.replyToSenderId;
  if (typeof replyToSenderId === "string" && replyToSenderId.length > 0) {
    return replyToSenderId;
  }

  const replyAuthor = extractReplyAuthorRecord(memory);
  const id = replyAuthor?.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  return undefined;
}

const LEGACY_DISCORD_REACTION_RE = /^\*(Added|Removed) <(.+?)> (?:to|from):/i;

function extractDiscordReactionEvent(
  memory: Memory,
): DiscordReactionEvent | null {
  const targetMessageId = extractReplyToMessageId(memory);
  if (!targetMessageId) {
    return null;
  }

  const meta = memory.metadata as Record<string, unknown> | undefined;
  const reactionMeta =
    meta?.discordReaction && typeof meta.discordReaction === "object"
      ? (meta.discordReaction as Record<string, unknown>)
      : null;

  const structuredAction =
    reactionMeta?.action === "add" || reactionMeta?.action === "remove"
      ? reactionMeta.action
      : null;
  const structuredEmoji =
    typeof reactionMeta?.emoji === "string" &&
    reactionMeta.emoji.trim().length > 0
      ? reactionMeta.emoji.trim()
      : null;

  if (structuredAction && structuredEmoji) {
    return {
      action: structuredAction,
      emoji: structuredEmoji,
      targetMessageId,
      userKey:
        memory.entityId ?? memory.id ?? `${targetMessageId}:${structuredEmoji}`,
      userLabel: extractFrom(memory) ?? extractFromUserName(memory),
    };
  }

  const source = extractSource(memory);
  if (!isDiscordConnectorSource(source)) {
    return null;
  }

  const text = extractText(memory).trim();
  const legacyMatch = text.match(LEGACY_DISCORD_REACTION_RE);
  if (!legacyMatch) {
    return null;
  }

  return {
    action: legacyMatch[1].toLowerCase() === "added" ? "add" : "remove",
    emoji: legacyMatch[2].trim(),
    targetMessageId,
    userKey:
      memory.entityId ?? memory.id ?? `${targetMessageId}:${legacyMatch[2]}`,
    userLabel: extractFrom(memory) ?? extractFromUserName(memory),
  };
}

function buildMessageReactionMap(
  memories: Memory[],
): Map<string, InboxReaction[]> {
  const stateByTargetId = new Map<
    string,
    Map<string, ReactionAggregateState>
  >();
  const chronologicallySortedMemories = [...memories].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );

  for (const memory of chronologicallySortedMemories) {
    const event = extractDiscordReactionEvent(memory);
    if (!event) {
      continue;
    }

    const byEmoji =
      stateByTargetId.get(event.targetMessageId) ??
      new Map<string, ReactionAggregateState>();
    const aggregate = byEmoji.get(event.emoji) ?? {
      emoji: event.emoji,
      users: new Map<string, string | undefined>(),
    };

    if (event.action === "add") {
      aggregate.users.set(event.userKey, event.userLabel);
      byEmoji.set(event.emoji, aggregate);
      stateByTargetId.set(event.targetMessageId, byEmoji);
      continue;
    }

    aggregate.users.delete(event.userKey);
    if (aggregate.users.size === 0) {
      byEmoji.delete(event.emoji);
    } else {
      byEmoji.set(event.emoji, aggregate);
    }

    if (byEmoji.size === 0) {
      stateByTargetId.delete(event.targetMessageId);
    } else {
      stateByTargetId.set(event.targetMessageId, byEmoji);
    }
  }

  const reactionsByTargetId = new Map<string, InboxReaction[]>();
  for (const [targetMessageId, byEmoji] of stateByTargetId) {
    const reactions = Array.from(byEmoji.values())
      .map((aggregate) => {
        const users = Array.from(aggregate.users.values()).filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        );
        return {
          emoji: aggregate.emoji,
          count: aggregate.users.size,
          ...(users.length > 0 ? { users } : {}),
        };
      })
      .filter((reaction) => reaction.count > 0);
    if (reactions.length > 0) {
      reactionsByTargetId.set(targetMessageId, reactions);
    }
  }

  return reactionsByTargetId;
}

type DiscordUserProfile = {
  avatarUrl?: string;
  displayName?: string;
  username?: string;
};

type DiscordMessageAuthorProfile = DiscordUserProfile & {
  rawUserId?: string;
};

type StoredDiscordEntityProfile = {
  avatarUrl?: string;
  displayName?: string;
  rawUserId?: string;
  username?: string;
};

const DISCORD_PROFILE_CACHE_TTL_MS = 5 * 60_000;
const discordRoomProfileCache = new Map<
  string,
  { expiresAt: number; value: DiscordRoomProfile | null }
>();
const discordUserProfileCache = new Map<
  string,
  { expiresAt: number; value: DiscordUserProfile | null }
>();
const discordMessageAuthorProfileCache = new Map<
  string,
  { expiresAt: number; value: DiscordMessageAuthorProfile | null }
>();

function readCachedValue<T>(
  cache: Map<string, { expiresAt: number; value: T }>,
  key: string,
): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

type DiscordClientLike = {
  channels?: {
    cache?: { get?: (id: string) => unknown };
    fetch?: (id: string) => Promise<unknown>;
  };
  users?: {
    fetch?: (id: string) => Promise<unknown>;
  };
};

function getDiscordClient(runtime: AgentRuntime): DiscordClientLike | null {
  const runtimeWithServices = runtime as AgentRuntime & {
    getService?: (name: string) => unknown;
  };
  const service = runtimeWithServices.getService?.("discord") as
    | { client?: DiscordClientLike | null }
    | undefined;
  return service?.client ?? null;
}

function firstCollectionValue(collection: unknown): unknown {
  if (!collection || typeof collection !== "object") {
    return null;
  }
  const record = collection as {
    first?: () => unknown;
    values?: () => IterableIterator<unknown>;
  };
  if (typeof record.first === "function") {
    return record.first();
  }
  if (typeof record.values === "function") {
    return record.values().next().value ?? null;
  }
  return null;
}

function readDiscordDisplayName(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const record = user as Record<string, unknown>;
  const globalName = record.globalName;
  if (typeof globalName === "string" && globalName.trim()) {
    return globalName.trim();
  }
  const displayName = record.displayName;
  if (typeof displayName === "string" && displayName.trim()) {
    return displayName.trim();
  }
  const username = record.username;
  if (typeof username === "string" && username.trim()) {
    return username.trim();
  }
  return undefined;
}

function readDiscordAvatarUrl(user: unknown): string | undefined {
  if (!user || typeof user !== "object") return undefined;
  const record = user as {
    displayAvatarURL?: () => string;
    avatarURL?: () => string | null;
  };
  if (typeof record.displayAvatarURL === "function") {
    const url = record.displayAvatarURL();
    if (typeof url === "string" && url.trim()) return url;
  }
  if (typeof record.avatarURL === "function") {
    const url = record.avatarURL();
    if (typeof url === "string" && url.trim()) return url;
  }
  return undefined;
}

function readStoredDiscordEntityProfile(
  entity: unknown,
): StoredDiscordEntityProfile | null {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  const metadata = (entity as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const discord =
    record.discord && typeof record.discord === "object"
      ? (record.discord as Record<string, unknown>)
      : null;
  const fallback =
    record.default && typeof record.default === "object"
      ? (record.default as Record<string, unknown>)
      : null;

  const displayName =
    readLooseStringValue(record, ["displayName", "name"]) ??
    readLooseStringValue(discord ?? undefined, [
      "displayName",
      "globalName",
      "name",
    ]) ??
    readLooseStringValue(fallback ?? undefined, ["name"]);
  const username =
    readLooseStringValue(record, ["username"]) ??
    readLooseStringValue(discord ?? undefined, ["username", "userName"]) ??
    readLooseStringValue(fallback ?? undefined, ["username"]);
  const avatarUrl =
    readLooseStringValue(record, ["avatarUrl"]) ??
    readLooseStringValue(discord ?? undefined, ["avatarUrl"]) ??
    readLooseStringValue(fallback ?? undefined, ["avatarUrl"]);
  const rawUserId =
    readLooseStringValue(discord ?? undefined, ["userId", "id"]) ??
    readLooseStringValue(record, ["originalId"]);

  if (!displayName && !username && !avatarUrl && !rawUserId) {
    return null;
  }

  return {
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(displayName ? { displayName } : {}),
    ...(rawUserId ? { rawUserId } : {}),
    ...(username ? { username } : {}),
  };
}

async function resolveStoredDiscordEntityProfile(
  runtime: AgentRuntime,
  entityId: string | undefined,
): Promise<StoredDiscordEntityProfile | null> {
  if (!entityId) return null;

  const runtimeWithEntityLookup = runtime as AgentRuntime & {
    getEntityById?: (id: UUID) => Promise<unknown>;
  };
  if (typeof runtimeWithEntityLookup.getEntityById !== "function") {
    return null;
  }

  try {
    const entity = await runtimeWithEntityLookup.getEntityById(
      entityId as UUID,
    );
    return readStoredDiscordEntityProfile(entity);
  } catch {
    return null;
  }
}

async function cacheInboxDiscordAvatar(
  runtime: AgentRuntime,
  avatarUrl: string | undefined,
  userId?: string,
): Promise<string | undefined> {
  return cacheDiscordAvatarUrl(avatarUrl, {
    fetchImpl: runtime.fetch ?? globalThis.fetch,
    userId,
  });
}

async function resolveDiscordMessageAuthorProfile(
  runtime: AgentRuntime,
  channelId: string,
  messageId: string,
): Promise<DiscordMessageAuthorProfile | null> {
  const cacheKey = `${channelId}:${messageId}`;
  const cached = readCachedValue(discordMessageAuthorProfileCache, cacheKey);
  if (cached !== undefined) return cached;

  const client = getDiscordClient(runtime);
  const cachedChannel = client?.channels?.cache?.get?.(channelId);
  const fetchChannel = client?.channels?.fetch;
  const channel =
    cachedChannel ??
    (typeof fetchChannel === "function"
      ? await fetchChannel(channelId).catch(() => null)
      : null);

  const fetchMessage =
    channel &&
    typeof channel === "object" &&
    typeof (channel as { messages?: { fetch?: unknown } }).messages?.fetch ===
      "function"
      ? (channel as { messages: { fetch: (id: string) => Promise<unknown> } })
          .messages.fetch
      : null;
  if (!fetchMessage) {
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }

  try {
    const message = await fetchMessage(messageId);
    const author =
      message && typeof message === "object"
        ? ((message as { author?: unknown }).author ?? null)
        : null;
    const member =
      message && typeof message === "object"
        ? ((message as { member?: unknown }).member ?? null)
        : null;
    const rawUserId =
      author &&
      typeof author === "object" &&
      typeof (author as { id?: unknown }).id === "string"
        ? (author as { id: string }).id
        : undefined;
    const profile: DiscordMessageAuthorProfile = {
      displayName: readDiscordDisplayName(member ?? author),
      username:
        author &&
        typeof author === "object" &&
        typeof (author as { username?: unknown }).username === "string"
          ? (author as { username: string }).username
          : undefined,
      avatarUrl: readDiscordAvatarUrl(author),
      ...(rawUserId ? { rawUserId } : {}),
    };
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: profile,
    });
    return profile;
  } catch {
    discordMessageAuthorProfileCache.set(cacheKey, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }
}

async function resolveDiscordUserProfile(
  runtime: AgentRuntime,
  userId: string,
): Promise<DiscordUserProfile | null> {
  const cached = readCachedValue(discordUserProfileCache, userId);
  if (cached !== undefined) return cached;

  const client = getDiscordClient(runtime);
  const fetchUser = client?.users?.fetch;
  if (typeof fetchUser !== "function") return null;

  try {
    const user = await fetchUser(userId);
    const profile: DiscordUserProfile = {
      displayName: readDiscordDisplayName(user),
      username:
        user &&
        typeof user === "object" &&
        typeof (user as { username?: unknown }).username === "string"
          ? (user as { username: string }).username
          : undefined,
      avatarUrl: readDiscordAvatarUrl(user),
    };
    discordUserProfileCache.set(userId, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: profile,
    });
    return profile;
  } catch {
    discordUserProfileCache.set(userId, {
      expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
      value: null,
    });
    return null;
  }
}

async function resolveDiscordRoomProfile(
  runtime: AgentRuntime,
  room: Room | undefined,
  channelIdHint?: string,
): Promise<DiscordRoomProfile | null> {
  const channelId =
    typeof channelIdHint === "string" && channelIdHint.trim()
      ? channelIdHint.trim()
      : (readRoomChannelId(room) ?? "");
  if (!channelId) return null;

  const cached = readCachedValue(discordRoomProfileCache, channelId);
  if (cached !== undefined) return cached;

  const client = getDiscordClient(runtime);
  const cachedChannel = client?.channels?.cache?.get?.(channelId);
  const fetchChannel = client?.channels?.fetch;
  const channel =
    cachedChannel ??
    (typeof fetchChannel === "function"
      ? await fetchChannel(channelId).catch(() => null)
      : null);

  let title: string | null = null;
  let avatarUrl: string | undefined;
  if (channel && typeof channel === "object") {
    const namedChannel = channel as { name?: unknown };
    if (typeof namedChannel.name === "string" && namedChannel.name.trim()) {
      title = namedChannel.name.trim();
    } else {
      const record = channel as {
        recipient?: unknown;
        recipients?: unknown;
      };
      const recipient =
        record.recipient ?? firstCollectionValue(record.recipients);
      title = readDiscordDisplayName(recipient) ?? null;
      avatarUrl = readDiscordAvatarUrl(recipient);
    }
  }

  const profile: DiscordRoomProfile = {
    title,
    ...(typeof avatarUrl === "string" && avatarUrl.length > 0
      ? { avatarUrl }
      : {}),
  };

  discordRoomProfileCache.set(channelId, {
    expiresAt: Date.now() + DISCORD_PROFILE_CACHE_TTL_MS,
    value: profile,
  });
  return profile;
}

/**
 * Enumerate every room the agent currently has state for, up to
 * MAX_ROOMS_SCANNED. We do this by walking every world the runtime
 * knows about and collecting rooms under each. For a single-agent
 * Eliza install this is bounded by the number of connector chats the
 * agent participates in; for multi-tenant it would need a tenant scope
 * but Eliza's runtime is single-tenant per process.
 */
async function collectAgentRoomIds(runtime: AgentRuntime): Promise<UUID[]> {
  const worlds = await runtime.getAllWorlds();
  if (worlds.length === 0) return [];

  const worldIds = worlds
    .map((w) => w.id)
    .filter((id): id is UUID => typeof id === "string");

  if (worldIds.length === 0) return [];

  // getRoomsByWorlds is the bulk form — single round trip instead of
  // one query per world.
  const rooms = await runtime.getRoomsByWorlds(worldIds, MAX_ROOMS_SCANNED, 0);
  const roomIds: UUID[] = [];
  for (const room of rooms) {
    if (room.id) roomIds.push(room.id);
    if (roomIds.length >= MAX_ROOMS_SCANNED) break;
  }
  return roomIds;
}

async function collectAgentWorlds(
  runtime: AgentRuntime,
): Promise<Map<UUID, World>> {
  const worlds = await runtime.getAllWorlds();
  const worldsById = new Map<UUID, World>();
  for (const world of worlds) {
    if (!world.id) continue;
    // Skip internal scratch worlds — autonomy self-talk, advanced memory,
    // relationships graph. These accumulate hundreds of synthetic rooms
    // that crowd real connector channels out of the room-scan budget.
    if (isInternalWorld(world)) continue;
    worldsById.set(world.id, world);
  }
  return worldsById;
}

/**
 * Collect every room owned by the agent (bounded by MAX_ROOMS_SCANNED)
 * as full Room objects rather than just ids. Used by the chats
 * aggregator which needs each room's name + world for display.
 */
async function collectAgentRooms(runtime: AgentRuntime): Promise<Room[]> {
  const worldsById = await collectAgentWorlds(runtime);
  if (worldsById.size === 0) return [];
  const worldIds = Array.from(worldsById.keys()).filter(
    (id): id is UUID => typeof id === "string",
  );
  if (worldIds.length === 0) return [];
  return runtime.getRoomsByWorlds(worldIds, MAX_ROOMS_SCANNED, 0);
}

function resolveInboxWorldLabel(
  room: Room | undefined,
  world: World | undefined,
): string {
  const namedWorld = readWorldName(world);
  if (namedWorld) {
    return namedWorld;
  }

  const roomServerId = readRoomServerId(room);
  if (roomServerId) {
    return roomServerId;
  }

  const worldServerId = readWorldServerId(world);
  if (worldServerId) {
    return worldServerId;
  }

  const roomType = readRoomType(room)?.trim().toUpperCase();
  if (roomType === "DM") {
    return "Direct messages";
  }

  const worldId = readRoomWorldId(room);
  if (worldId) {
    return worldId;
  }

  return "Unknown world";
}

async function loadRelevantRooms(
  runtime: AgentRuntime,
  requestedRoomId: UUID | null,
): Promise<Map<string, Room>> {
  const roomById = new Map<string, Room>();

  if (requestedRoomId) {
    const runtimeWithGetRoom = runtime as AgentRuntime & {
      getRoom?: (roomId: UUID) => Promise<Room | null | undefined>;
    };
    if (typeof runtimeWithGetRoom.getRoom === "function") {
      const room = await runtimeWithGetRoom.getRoom(requestedRoomId);
      if (room?.id) {
        roomById.set(room.id, room);
        return roomById;
      }
    }
  }

  const rooms = await collectAgentRooms(runtime);
  for (const room of rooms) {
    if (!room.id) continue;
    if (requestedRoomId && room.id !== requestedRoomId) continue;
    roomById.set(room.id, room);
  }

  return roomById;
}

function applyInboxChatMemory(
  accumulator: Map<
    string,
    {
      latestDiscordChannelId?: string;
      latestDiscordMessageId?: string;
      source: string;
      lastMessageText: string;
      lastMessageAt: number;
      messageCount: number;
      latestSenderAvatarUrl?: string;
      latestSenderEntityId?: string;
      latestSenderName?: string;
      latestSenderRawId?: string;
    }
  >,
  memory: Memory,
  room: Room | undefined,
  source: string,
): void {
  const key = memory.roomId;
  if (!key) return;

  const text = extractText(memory);
  if (!text) return;

  const ts = memory.createdAt ?? 0;
  const senderAvatarUrl = extractFromAvatarUrl(memory);
  const senderEntityId =
    typeof memory.entityId === "string" ? memory.entityId : undefined;
  const senderName =
    extractFrom(memory) ?? extractFromUserName(memory) ?? undefined;
  const senderRawId = extractRawSenderId(memory);
  const discordChannelId =
    extractDiscordChannelId(memory) ?? readRoomChannelId(room);
  const discordMessageId = extractDiscordMessageId(memory);

  const existing = accumulator.get(key);
  if (!existing) {
    accumulator.set(key, {
      latestDiscordChannelId: discordChannelId,
      latestDiscordMessageId: discordMessageId,
      source,
      lastMessageText: text.slice(0, INBOX_CHAT_PREVIEW_LENGTH),
      lastMessageAt: ts,
      messageCount: 1,
      latestSenderAvatarUrl: senderAvatarUrl,
      latestSenderEntityId: senderEntityId,
      latestSenderName: senderName,
      latestSenderRawId: senderRawId,
    });
    return;
  }

  existing.messageCount += 1;
  if (ts > existing.lastMessageAt) {
    existing.lastMessageAt = ts;
    existing.lastMessageText = text.slice(0, INBOX_CHAT_PREVIEW_LENGTH);
    existing.latestSenderAvatarUrl = senderAvatarUrl;
    existing.latestSenderEntityId = senderEntityId;
    existing.latestSenderName = senderName;
    existing.latestSenderRawId = senderRawId;
    existing.latestDiscordMessageId =
      discordMessageId ?? existing.latestDiscordMessageId;
    existing.latestDiscordChannelId =
      discordChannelId ?? existing.latestDiscordChannelId;
  } else if (!existing.latestDiscordChannelId && discordChannelId) {
    existing.latestDiscordChannelId = discordChannelId;
  } else if (!existing.latestDiscordMessageId && discordMessageId) {
    existing.latestDiscordMessageId = discordMessageId;
  }
}

async function loadLatestRoomMemory(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<Memory | null> {
  try {
    const memories = await runtime.getMemories({
      tableName: "messages",
      roomId,
      limit: 10,
      unique: false,
    });
    if (!Array.isArray(memories) || memories.length === 0) {
      return null;
    }
    const candidates = memories
      .filter((memory) => !extractDiscordReactionEvent(memory))
      .filter((memory) => extractText(memory).trim().length > 0)
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function augmentRoomsFromRecentMemories(
  runtime: AgentRuntime,
  roomById: Map<UUID, Room>,
  sourceFilter: Set<string>,
): Promise<void> {
  if (roomById.size >= MAX_ROOMS_SCANNED) {
    return;
  }

  const recentMemories = await runtime.getMemories({
    agentId: runtime.agentId,
    limit: ORPHAN_ROOM_MEMORY_SCAN_LIMIT,
    tableName: "messages",
    unique: false,
  });

  for (const memory of recentMemories) {
    if (roomById.size >= MAX_ROOMS_SCANNED) {
      break;
    }
    const roomId = memory.roomId;
    if (!roomId || roomById.has(roomId)) {
      continue;
    }

    const source = extractSource(memory);
    if (!source || !sourceFilter.has(source.toLowerCase())) {
      continue;
    }

    roomById.set(
      roomId as UUID,
      {
        id: roomId as UUID,
        name: normalizeRoomTitle(extractFrom(memory)) ?? undefined,
        source,
        type: "GROUP",
        room_type: "GROUP",
        channelId: extractDiscordChannelId(memory) ?? undefined,
        channel_id: extractDiscordChannelId(memory),
      } as Room,
    );
  }
}

/**
 * Fetch messages, optionally scoped to a single room. When `roomId`
 * is set the function skips world enumeration entirely and targets
 * that specific room — used by the cross-channel chat read path where the
 * sidebar already knows which room the user clicked. When `roomId`
 * is null it walks every agent room and merges across them, which is
 * the cross-channel "everything" feed.
 *
 * Either way the source filter applies: rows whose content.source
 * isn't in the allowed set are dropped before ordering, so callers
 * can never accidentally surface an internal trajectory/system memory
 * via this endpoint.
 */
async function loadInboxMessages(
  runtime: AgentRuntime,
  limit: number,
  sourceFilter: Set<string>,
  roomId: UUID | null,
  roomSourceHint: string | null,
): Promise<InboxMessage[]> {
  const roomById = await loadRelevantRooms(runtime, roomId);
  let memories: Memory[];
  if (roomId) {
    memories = await runtime.getMemories({
      tableName: "messages",
      roomId,
      limit: limit * PER_ROOM_OVERFETCH_MULTIPLIER,
      unique: false,
    });
  } else {
    const roomIds = await collectAgentRoomIds(runtime);
    if (roomIds.length === 0) return [];
    memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: limit * PER_ROOM_OVERFETCH_MULTIPLIER,
    });
  }

  const agentId = runtime.agentId;
  const reactionsByMessageId = buildMessageReactionMap(memories);
  const roomSourceById = new Map<string, string>();

  for (const [knownRoomId, room] of roomById) {
    const roomSource = readRoomSource(room);
    if (!roomSource || !sourceFilter.has(roomSource.toLowerCase())) continue;
    roomSourceById.set(knownRoomId, roomSource);
  }

  for (const memory of memories) {
    const source = extractSource(memory);
    if (!source || !sourceFilter.has(source.toLowerCase())) continue;
    const memoryRoomId = memory.roomId;
    if (!memoryRoomId || roomSourceById.has(memoryRoomId)) continue;
    roomSourceById.set(memoryRoomId, source);
  }

  const out: InboxMessageRecord[] = [];

  for (const memory of memories) {
    if (extractDiscordReactionEvent(memory)) {
      continue;
    }

    const room = roomById.get(memory.roomId ?? "");
    const explicitSource = extractSource(memory);
    const source =
      explicitSource ??
      roomSourceById.get(memory.roomId ?? "") ??
      (roomId
        ? (readRoomSource(room) ?? roomSourceHint ?? undefined)
        : undefined);
    if (!source || !sourceFilter.has(source.toLowerCase())) continue;

    const text = extractText(memory);
    if (!text) continue;

    out.push({
      id: memory.id ?? "",
      role: memory.entityId === agentId ? "assistant" : "user",
      text,
      timestamp: memory.createdAt ?? 0,
      source,
      rawDiscordChannelId:
        extractDiscordChannelId(memory) ?? readRoomChannelId(room),
      rawDiscordMessageId: extractDiscordMessageId(memory),
      responseId: extractResponseId(memory),
      roomId: memory.roomId ?? "",
      hasExternalUrl: extractContentUrl(memory) !== undefined,
      hasExplicitSource: explicitSource !== null,
      reactions: memory.id ? reactionsByMessageId.get(memory.id) : undefined,
      from: extractFrom(memory),
      fromUserName: extractFromUserName(memory),
      avatarUrl: extractFromAvatarUrl(memory),
      replyToMessageId: extractReplyToMessageId(memory),
      replyToSenderName: extractReplyToSenderName(memory),
      replyToSenderUserName: extractReplyToSenderUserName(memory),
      rawReplyToSenderId: extractReplyToSenderId(memory),
      senderEntityId:
        typeof memory.entityId === "string" ? memory.entityId : undefined,
      rawSenderId: extractRawSenderId(memory),
    });
  }

  const deduped = dedupeInboxMessages(out);

  // Newest first. The core API doesn't guarantee order across rooms, so
  // we do the merge sort client-side.
  deduped.sort((a, b) => b.timestamp - a.timestamp);
  const ordered = deduped.slice(0, limit);

  await Promise.all(
    ordered.map(async (message) => {
      if (!isDiscordConnectorSource(message.source)) return;
      const storedSenderProfile = await resolveStoredDiscordEntityProfile(
        runtime,
        message.senderEntityId,
      );
      if (!message.from && storedSenderProfile?.displayName) {
        message.from = storedSenderProfile.displayName;
      }
      if (!message.fromUserName && storedSenderProfile?.username) {
        message.fromUserName = storedSenderProfile.username;
      }
      if (!message.avatarUrl && storedSenderProfile?.avatarUrl) {
        message.avatarUrl = storedSenderProfile.avatarUrl;
      }

      const messageAuthorProfile =
        message.rawDiscordChannelId && message.rawDiscordMessageId
          ? await resolveDiscordMessageAuthorProfile(
              runtime,
              message.rawDiscordChannelId,
              message.rawDiscordMessageId,
            )
          : null;
      if (!message.from && messageAuthorProfile?.displayName) {
        message.from = messageAuthorProfile.displayName;
      }
      if (!message.fromUserName && messageAuthorProfile?.username) {
        message.fromUserName = messageAuthorProfile.username;
      }
      if (!message.avatarUrl && messageAuthorProfile?.avatarUrl) {
        message.avatarUrl = messageAuthorProfile.avatarUrl;
      }

      const rawSenderId =
        message.rawSenderId ??
        storedSenderProfile?.rawUserId ??
        messageAuthorProfile?.rawUserId;
      if (rawSenderId) {
        const profile = await resolveDiscordUserProfile(runtime, rawSenderId);
        if (profile) {
          if (profile.displayName) {
            message.from = profile.displayName;
          }
          if (profile.username) {
            message.fromUserName = profile.username;
          }
          if (profile.avatarUrl) {
            message.avatarUrl = profile.avatarUrl;
          }
        }
      }
      message.avatarUrl = await cacheInboxDiscordAvatar(
        runtime,
        message.avatarUrl,
        rawSenderId,
      );
      if (message.rawReplyToSenderId) {
        const replyProfile = await resolveDiscordUserProfile(
          runtime,
          message.rawReplyToSenderId,
        );
        if (replyProfile) {
          if (replyProfile.displayName) {
            message.replyToSenderName = replyProfile.displayName;
          }
          if (replyProfile.username) {
            message.replyToSenderUserName = replyProfile.username;
          }
        }
      }
    }),
  );

  return ordered.map(
    ({
      hasExternalUrl: _hasExternalUrl,
      hasExplicitSource: _hasExplicitSource,
      rawDiscordChannelId: _rawDiscordChannelId,
      rawDiscordMessageId: _rawDiscordMessageId,
      rawReplyToSenderId: _rawReplyToSenderId,
      senderEntityId: _senderEntityId,
      rawSenderId: _rawSenderId,
      responseId: _responseId,
      ...message
    }) => message,
  );
}

function normalizeInboxComparableText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function getInboxMessagePreferenceScore(message: InboxMessageRecord): number {
  let score = 0;
  if (message.hasExternalUrl) score += 8;
  if (message.hasExplicitSource) score += 8;
  if (message.replyToSenderName || message.replyToSenderUserName) score += 4;
  if (message.rawReplyToSenderId) score += 2;
  if (message.rawSenderId) score += 1;
  if (message.avatarUrl) score += 1;
  return score;
}

function isConnectorVisibleDiscordAssistantMessage(
  message: InboxMessageRecord,
): boolean {
  return (
    isDiscordConnectorSource(message.source) &&
    message.role === "assistant" &&
    (message.hasExplicitSource || message.hasExternalUrl)
  );
}

function isImplicitDiscordAssistantShadow(
  message: InboxMessageRecord,
): boolean {
  return (
    isDiscordConnectorSource(message.source) &&
    message.role === "assistant" &&
    !message.hasExplicitSource &&
    !message.hasExternalUrl
  );
}

function buildDiscordReplyKey(message: InboxMessageRecord): string | null {
  const replyToMessageId = message.replyToMessageId?.trim();
  if (!replyToMessageId) {
    return null;
  }
  return `${message.roomId}\u0000${replyToMessageId}`;
}

function suppressUnsentDiscordAssistantShadows(
  messages: InboxMessageRecord[],
): InboxMessageRecord[] {
  const latestVisibleReplyByKey = new Map<string, number>();

  for (const message of messages) {
    if (!isConnectorVisibleDiscordAssistantMessage(message)) {
      continue;
    }

    const replyKey = buildDiscordReplyKey(message);
    if (!replyKey) {
      continue;
    }

    const existingTimestamp = latestVisibleReplyByKey.get(replyKey) ?? 0;
    if (message.timestamp >= existingTimestamp) {
      latestVisibleReplyByKey.set(replyKey, message.timestamp);
    }
  }

  return messages.filter((message) => {
    if (!isImplicitDiscordAssistantShadow(message)) {
      return true;
    }

    const replyKey = buildDiscordReplyKey(message);
    if (!replyKey) {
      return true;
    }

    const latestVisibleTimestamp = latestVisibleReplyByKey.get(replyKey);
    if (latestVisibleTimestamp === undefined) {
      return true;
    }

    return message.timestamp > latestVisibleTimestamp;
  });
}

function areLikelyConnectorAssistantDuplicates(
  left: InboxMessageRecord,
  right: InboxMessageRecord,
): boolean {
  if (left.role !== "assistant" || right.role !== "assistant") {
    return false;
  }
  if (left.roomId !== right.roomId) {
    return false;
  }
  if (
    normalizeInboxComparableText(left.text) !==
    normalizeInboxComparableText(right.text)
  ) {
    return false;
  }

  const leftResponseId = left.responseId?.trim() ?? "";
  const rightResponseId = right.responseId?.trim() ?? "";
  if (leftResponseId && rightResponseId) {
    return leftResponseId === rightResponseId;
  }

  if (left.hasExplicitSource === right.hasExplicitSource) {
    return false;
  }
  if (Math.abs(left.timestamp - right.timestamp) > 15_000) {
    return false;
  }

  const leftReplyId = left.replyToMessageId?.trim() ?? "";
  const rightReplyId = right.replyToMessageId?.trim() ?? "";
  if (leftReplyId && rightReplyId) {
    return leftReplyId === rightReplyId;
  }

  return true;
}

function dedupeInboxMessages(
  messages: InboxMessageRecord[],
): InboxMessageRecord[] {
  const filteredMessages = suppressUnsentDiscordAssistantShadows(messages);
  const deduped: InboxMessageRecord[] = [];

  for (const message of filteredMessages) {
    const duplicateIndex = deduped.findIndex((candidate) =>
      areLikelyConnectorAssistantDuplicates(candidate, message),
    );

    if (duplicateIndex === -1) {
      deduped.push(message);
      continue;
    }

    const existing = deduped[duplicateIndex];
    const existingScore = getInboxMessagePreferenceScore(existing);
    const nextScore = getInboxMessagePreferenceScore(message);

    if (
      nextScore > existingScore ||
      (nextScore === existingScore && message.timestamp > existing.timestamp)
    ) {
      deduped[duplicateIndex] = message;
    }
  }

  return deduped;
}

/**
 * A single entry in the chats list. Mirrors the shape the
 * ConversationsSidebar needs (id, title, updatedAt preview) so the
 * frontend can render dashboard conversations and connector chats in
 * the same list without a type dance.
 */
interface InboxChat {
  /** Room id — stable across polls, used as the selection key. */
  id: string;
  /** Connector tag (imessage, telegram, …) for source badging. */
  source: string;
  /** Raw runtime transport source used for replies and send routing. */
  transportSource?: string;
  /** Whether the active runtime currently has a send handler for this room. */
  canSend?: boolean;
  /** Owning world/server id when this room belongs to one. */
  worldId?: string;
  /** User-facing world/server label for filters and grouped headers. */
  worldLabel: string;
  /**
   * Normalized room kind. "DM" for 1:1 direct messages the connector
   * exposes as private chats; other platform-specific strings (GROUP,
   * CHANNEL, VOICE, …) for everything else. Optional because not every
   * connector tags rooms.
   */
  roomType?: string;
  /** Display title — contact name for 1:1 chats, group name otherwise. */
  title: string;
  /** Best-effort avatar URL for direct chats when the connector exposes one. */
  avatarUrl?: string;
  /** Last message text preview (truncated) so the list row can render it. */
  lastMessageText: string;
  /** Epoch ms of the most recent message in this room. */
  lastMessageAt: number;
  /** Total messages in this room at scan time (for an optional counter). */
  messageCount: number;
}

/** Cap on how many characters of last-message text we return per chat. */
const INBOX_CHAT_PREVIEW_LENGTH = 140;

type DiscordRoomProfile = {
  avatarUrl?: string;
  title: string | null;
};

/**
 * Walk every agent room, collect the subset that contain connector
 * messages, and reduce each to a single InboxChat row with the room's
 * latest activity as the ordering key. This is the sidebar feed for
 * the messages view — one row per external chat thread.
 *
 * We over-fetch memories across all rooms in one bulk call (same
 * pattern loadInboxMessages uses) then group client-side. For the
 * single-agent single-process topology Eliza runs under, this is
 * cheap enough to call on a 5-second poll without special-casing.
 */
async function loadInboxChats(
  runtime: AgentRuntime,
  sourceFilter: Set<string>,
): Promise<InboxChat[]> {
  const worldsById = await collectAgentWorlds(runtime);
  const rooms =
    worldsById.size > 0
      ? await runtime.getRoomsByWorlds(
          Array.from(worldsById.keys()),
          MAX_ROOMS_SCANNED,
          0,
        )
      : [];
  if (rooms.length === 0) return [];

  // Build an id → Room lookup so the memory reducer can fill in the
  // chat title from the room's own name field (plugins stamp this when
  // they create the room from ENTITY_JOINED / WORLD_JOINED).
  const roomById = new Map<UUID, Room>();
  for (const room of rooms) {
    if (room.id) roomById.set(room.id, room);
  }

  await augmentRoomsFromRecentMemories(runtime, roomById, sourceFilter);

  const roomIds = Array.from(roomById.keys());
  if (roomIds.length === 0) return [];

  // Fetch a wide slice of recent memories in one call and group by
  // room client-side. 2000 messages is enough to catch the latest turn
  // in every active connector chat — the bulk query is the expensive
  // part, so we fetch once and reduce.
  const memories = await runtime.getMemoriesByRoomIds({
    tableName: "messages",
    roomIds,
    limit: 2000,
  });

  // Reduce: per room, keep the most recent source-tagged message.
  const accumulator = new Map<
    string,
    {
      latestDiscordChannelId?: string;
      latestDiscordMessageId?: string;
      source: string;
      lastMessageText: string;
      lastMessageAt: number;
      messageCount: number;
      latestSenderAvatarUrl?: string;
      latestSenderEntityId?: string;
      latestSenderName?: string;
      latestSenderRawId?: string;
    }
  >();

  const roomSourceById = new Map<string, string>();
  for (const [knownRoomId, room] of roomById) {
    const roomSource = readRoomSource(room);
    if (!roomSource || !sourceFilter.has(roomSource.toLowerCase())) continue;
    roomSourceById.set(knownRoomId, roomSource);
  }
  for (const memory of memories) {
    const source = extractSource(memory);
    if (!source || !sourceFilter.has(source.toLowerCase())) continue;
    const key = memory.roomId;
    if (!key || roomSourceById.has(key)) continue;
    roomSourceById.set(key, source);
  }

  for (const memory of memories) {
    const key = memory.roomId;
    if (!key) continue;

    if (extractDiscordReactionEvent(memory)) {
      continue;
    }

    const room = roomById.get(key as UUID);
    const source =
      extractSource(memory) ??
      roomSourceById.get(key) ??
      readRoomSource(room) ??
      undefined;
    if (!source || !sourceFilter.has(source.toLowerCase())) continue;
    applyInboxChatMemory(accumulator, memory, room, source);
  }

  const backfilledRooms = await Promise.all(
    Array.from(roomById.entries())
      .filter(([roomIdKey]) => !accumulator.has(roomIdKey))
      .filter(([, room]) => {
        const roomSource = readRoomSource(room);
        return !!roomSource && sourceFilter.has(roomSource.toLowerCase());
      })
      .map(async ([roomIdKey, room]) => {
        const latestMemory = await loadLatestRoomMemory(
          runtime,
          roomIdKey as UUID,
        );
        return { latestMemory, room, roomIdKey };
      }),
  );

  for (const { latestMemory, room, roomIdKey } of backfilledRooms) {
    if (latestMemory) {
      const source =
        extractSource(latestMemory) ?? readRoomSource(room) ?? undefined;
      if (source && sourceFilter.has(source.toLowerCase())) {
        applyInboxChatMemory(accumulator, latestMemory, room, source);
      }
      continue;
    }

    const roomSource = readRoomSource(room);
    if (!roomSource || !sourceFilter.has(roomSource.toLowerCase())) {
      continue;
    }
    accumulator.set(roomIdKey, {
      latestDiscordChannelId: readRoomChannelId(room),
      source: roomSource,
      lastMessageText: "",
      lastMessageAt: readRoomCreatedAt(room) ?? 0,
      messageCount: 0,
    });
  }

  const chats: InboxChat[] = [];
  for (const [roomIdKey, entry] of accumulator) {
    const room = roomById.get(roomIdKey as UUID);
    const worldId = readRoomWorldId(room);
    const world = worldId ? worldsById.get(worldId as UUID) : undefined;
    const liveDiscordProfile = isDiscordConnectorSource(entry.source)
      ? await resolveDiscordRoomProfile(
          runtime,
          room,
          entry.latestDiscordChannelId,
        )
      : null;
    const latestSenderEntityProfile = isDiscordConnectorSource(entry.source)
      ? await resolveStoredDiscordEntityProfile(
          runtime,
          entry.latestSenderEntityId,
        )
      : null;
    const latestMessageAuthorProfile =
      isDiscordConnectorSource(entry.source) &&
      entry.latestDiscordChannelId &&
      entry.latestDiscordMessageId
        ? await resolveDiscordMessageAuthorProfile(
            runtime,
            entry.latestDiscordChannelId,
            entry.latestDiscordMessageId,
          )
        : null;
    const latestSenderProfile =
      isDiscordConnectorSource(entry.source) &&
      (entry.latestSenderRawId ??
        latestSenderEntityProfile?.rawUserId ??
        latestMessageAuthorProfile?.rawUserId)
        ? await resolveDiscordUserProfile(
            runtime,
            (entry.latestSenderRawId ??
              latestSenderEntityProfile?.rawUserId ??
              latestMessageAuthorProfile?.rawUserId) as string,
          )
        : null;
    const rawStoredTitle = normalizeRoomTitle(room?.name);
    const roomType = readRoomType(room);
    const storedTitle =
      roomType !== "DM" &&
      (isPlaceholderConversationTitle(rawStoredTitle) ||
        equalsNormalizedTitle(rawStoredTitle, entry.latestSenderName ?? null) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestSenderEntityProfile?.displayName ?? null,
        ) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestMessageAuthorProfile?.displayName ?? null,
        ) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestSenderProfile?.displayName ?? null,
        ) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestSenderEntityProfile?.username ?? null,
        ) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestMessageAuthorProfile?.username ?? null,
        ) ||
        equalsNormalizedTitle(
          rawStoredTitle,
          latestSenderProfile?.username ?? null,
        ))
        ? null
        : rawStoredTitle;
    const dmFallbackTitle =
      roomType === "DM" &&
      (entry.latestSenderName ??
        latestSenderEntityProfile?.displayName ??
        latestMessageAuthorProfile?.displayName ??
        latestSenderProfile?.displayName)
        ? (entry.latestSenderName ??
          latestSenderEntityProfile?.displayName ??
          latestMessageAuthorProfile?.displayName ??
          latestSenderProfile?.displayName ??
          null)
        : null;
    const title =
      liveDiscordProfile?.title ??
      storedTitle ??
      dmFallbackTitle ??
      `${entry.source} chat`;
    const titleMatchesLatestSender =
      typeof entry.latestSenderName === "string" &&
      entry.latestSenderName.trim().length > 0 &&
      entry.latestSenderName.trim().toLowerCase() === title.toLowerCase();
    const shouldUsePersonAvatar = isDiscordConnectorSource(entry.source)
      ? true
      : roomType === "DM" || titleMatchesLatestSender;
    const resolvedAvatarUrl = shouldUsePersonAvatar
      ? (liveDiscordProfile?.avatarUrl ??
        latestSenderEntityProfile?.avatarUrl ??
        latestMessageAuthorProfile?.avatarUrl ??
        latestSenderProfile?.avatarUrl ??
        entry.latestSenderAvatarUrl)
      : undefined;
    chats.push({
      canSend: runtimeHasSendHandler(runtime, entry.source),
      id: roomIdKey,
      source: normalizeConnectorSource(entry.source),
      transportSource: entry.source,
      ...(worldId ? { worldId } : {}),
      worldLabel: resolveInboxWorldLabel(room, world),
      ...(roomType ? { roomType } : {}),
      title,
      avatarUrl: isDiscordConnectorSource(entry.source)
        ? await cacheInboxDiscordAvatar(
            runtime,
            resolvedAvatarUrl,
            entry.latestSenderRawId ??
              latestSenderEntityProfile?.rawUserId ??
              latestMessageAuthorProfile?.rawUserId,
          )
        : resolvedAvatarUrl,
      lastMessageText: entry.lastMessageText,
      lastMessageAt: entry.lastMessageAt,
      messageCount: entry.messageCount,
    });
  }

  chats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return chats;
}

/**
 * Scan recent memories across all agent rooms and return the distinct
 * set of source tags present. Used by the UI to build the filter chip
 * list dynamically — no hardcoded connector names in the frontend.
 */
async function loadInboxSources(runtime: AgentRuntime): Promise<string[]> {
  const roomIds = await collectAgentRoomIds(runtime);
  if (roomIds.length === 0) return [];

  // Sample a bounded page so this stays cheap. 1000 messages is enough
  // to catch every source an active agent uses day-to-day.
  const memories = await runtime.getMemoriesByRoomIds({
    tableName: "messages",
    roomIds,
    limit: 1000,
  });

  const seen = new Set<string>();
  for (const memory of memories) {
    const source = extractSource(memory);
    if (!source) continue;
    // We only care about inbox sources — skip client_chat / api / etc.
    if (!DEFAULT_INBOX_SOURCES.has(source.toLowerCase())) continue;
    const normalizedSource = normalizeConnectorSource(source);
    if (!normalizedSource) continue;
    seen.add(normalizedSource);
  }
  return Array.from(seen).sort();
}

/**
 * Route handler entry point. Returns `true` when a route matched and
 * the response has been written; `false` so the caller can continue
 * trying other handlers. Mirrors the handleIMessageRoute pattern.
 */
export async function handleInboxRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: InboxRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith("/api/inbox")) return false;

  // ── GET /api/inbox/messages ───────────────────────────────────────
  if (method === "GET" && pathname === "/api/inbox/messages") {
    const runtime = state.runtime;
    if (!runtime) {
      helpers.json(res, { messages: [], count: 0 });
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const limit = parseLimit(url.searchParams.get("limit"));
    const explicitFilter = parseSourceFilter(url.searchParams.get("sources"));
    const sourceFilter = explicitFilter ?? DEFAULT_INBOX_SOURCES;
    // Optional roomId scope. When the messages view has a
    // specific connector chat selected, it passes the roomId so the
    // aggregator can skip cross-room enumeration and return just that
    // room's messages. Validated as non-empty; the runtime accepts
    // UUIDs but won't error on arbitrary strings, so we keep parsing
    // forgiving here and let runtime.getMemoriesByRoomIds return empty
    // for bad ids.
    const roomIdParam = url.searchParams.get("roomId")?.trim() ?? "";
    const roomId = roomIdParam.length > 0 ? (roomIdParam as UUID) : null;
    const roomSourceParam = url.searchParams.get("roomSource")?.trim() ?? "";
    const roomSourceHint = roomSourceParam.length > 0 ? roomSourceParam : null;

    try {
      const messages = await loadInboxMessages(
        runtime,
        limit,
        sourceFilter,
        roomId,
        roomSourceHint,
      );
      helpers.json(res, { messages, count: messages.length });
    } catch (err) {
      helpers.error(
        res,
        `failed to load inbox: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/inbox/messages ──────────────────────────────────────
  if (method === "POST" && pathname === "/api/inbox/messages") {
    const runtime = state.runtime;
    if (!runtime) {
      helpers.error(res, "runtime not ready", 503);
      return true;
    }

    const body = await helpers.readJsonBody<{
      replyToMessageId?: string;
      roomId?: string;
      source?: string;
      text?: string;
    }>(req, res, { maxBytes: 256 * 1024 });
    if (!body) {
      return true;
    }

    const roomId = body.roomId?.trim();
    const source = body.source?.trim().toLowerCase();
    const text = body.text?.trim();
    const replyToMessageId = body.replyToMessageId?.trim();

    if (!roomId || !source || !text) {
      helpers.error(res, "roomId, source, and text are required", 400);
      return true;
    }

    if (!runtimeHasSendHandler(runtime, source)) {
      helpers.error(
        res,
        `no send handler registered for inbox source: ${source}`,
        409,
      );
      return true;
    }

    const room = await runtime.getRoom(roomId as UUID);
    if (!room) {
      helpers.error(res, "inbox room not found", 404);
      return true;
    }

    try {
      await runtime.sendMessageToTarget(
        {
          source,
          roomId: room.id,
          channelId: room.channelId ?? room.id,
          serverId: room.serverId,
        } as Parameters<typeof runtime.sendMessageToTarget>[0],
        {
          ...(replyToMessageId ? { inReplyTo: replyToMessageId } : {}),
          source,
          text,
        },
      );

      const [message] = await loadInboxMessages(
        runtime,
        1,
        new Set([source]),
        room.id as UUID,
        source,
      );

      helpers.json(res, message ? { ok: true, message } : { ok: true });
    } catch (err) {
      helpers.error(
        res,
        `failed to send inbox reply: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/inbox/chats ──────────────────────────────────────────
  // List of connector chat threads (one row per external chat room)
  // used by the messages sidebar. Each row carries the source
  // tag, a display title, last-message preview + timestamp, and a
  // message count. Dashboard conversations aren't included here — the
  // frontend merges this list with /api/conversations on its own.
  if (method === "GET" && pathname === "/api/inbox/chats") {
    const runtime = state.runtime;
    if (!runtime) {
      helpers.json(res, { chats: [], count: 0 });
      return true;
    }

    const url = new URL(req.url ?? pathname, "http://localhost");
    const explicitFilter = parseSourceFilter(url.searchParams.get("sources"));
    const sourceFilter = explicitFilter ?? DEFAULT_INBOX_SOURCES;

    try {
      const chats = await loadInboxChats(runtime, sourceFilter);
      helpers.json(res, { chats, count: chats.length });
    } catch (err) {
      helpers.error(
        res,
        `failed to load inbox chats: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/inbox/sources ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/inbox/sources") {
    const runtime = state.runtime;
    if (!runtime) {
      helpers.json(res, { sources: [] });
      return true;
    }

    try {
      const sources = await loadInboxSources(runtime);
      helpers.json(res, { sources });
    } catch (err) {
      helpers.error(
        res,
        `failed to load inbox sources: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  return false;
}
