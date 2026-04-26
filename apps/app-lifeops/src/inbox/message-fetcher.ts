import type { IAgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import {
  expandConnectorSourceFilter,
  type GetLifeOpsGmailTriageRequest,
  type LifeOpsGmailTriageFeed,
  type LifeOpsGoogleConnectorStatus,
  type LifeOpsXConnectorStatus,
  type LifeOpsXDm,
  normalizeConnectorSource,
} from "@elizaos/shared";
import { buildDeepLink, resolveChannelName } from "./channel-deep-links.js";
import type { InboundMessage } from "./types.js";

/**
 * Discord public channels are typically larger than DMs / threads. We use this
 * threshold both to treat sufficiently-large groups as broadcast channels and
 * to drive the v1 small-group filter in the Messages section.
 */
const PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD = 15;

const DEFAULT_SOURCES = [
  "discord",
  "telegram",
  "signal",
  "imessage",
  "whatsapp",
  "wechat",
  "slack",
  "sms",
] as const;

const MAX_ROOMS_SCANNED = 200;
const THREAD_CONTEXT_LIMIT = 5;
const SNIPPET_MAX_LENGTH = 200;
const INTERNAL_URL = new URL("http://127.0.0.1/");

export interface GmailInboxSource {
  getGoogleConnectorStatus(
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus>;
  getGmailTriage(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
  ): Promise<LifeOpsGmailTriageFeed>;
}

export interface XDmInboxSource {
  getXConnectorStatus(): Promise<LifeOpsXConnectorStatus>;
  syncXDms(opts?: { limit?: number }): Promise<{ synced: number }>;
  getXDms(opts?: { limit?: number }): Promise<LifeOpsXDm[]>;
}

export async function fetchChatMessages(
  runtime: IAgentRuntime,
  opts: {
    /** Only scan these sources (default: all chat connectors). */
    sources?: string[];
    /** Only return messages newer than this ISO timestamp. */
    sinceIso?: string;
    /** Max messages to return. */
    limit?: number;
  },
): Promise<InboundMessage[]> {
  const limit = opts.limit ?? 200;
  const sourceTags = expandConnectorSourceFilter(
    opts.sources ?? DEFAULT_SOURCES,
  );
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : 0;

  const allRoomIds = await runtime.getRoomsForParticipant(runtime.agentId);
  if (allRoomIds.length === 0) return [];

  const roomIds = allRoomIds.slice(0, MAX_ROOMS_SCANNED) as UUID[];
  const rooms = await Promise.all(roomIds.map((id) => runtime.getRoom(id)));
  const sourceRooms: Room[] = [];
  for (const room of rooms) {
    if (!room) continue;
    const roomSource = extractRoomSource(room);
    if (roomSource && sourceTags.has(roomSource)) {
      sourceRooms.push(room);
    }
  }

  if (sourceRooms.length === 0) return [];

  const sourceRoomIds = sourceRooms.map((r) => r.id) as UUID[];
  const memories = await runtime.getMemoriesByRoomIds({
    roomIds: sourceRoomIds,
    tableName: "messages",
    limit: limit * 3, // over-fetch for filtering
  });

  const filtered = memories.filter((m) => {
    if (m.entityId === runtime.agentId) return false;
    if (sinceMs > 0 && (m.createdAt ?? 0) < sinceMs) return false;
    const src = extractMemorySource(m);
    return src !== null && sourceTags.has(src);
  });

  filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const roomMap = new Map<string, Room>();
  for (const room of sourceRooms) {
    roomMap.set(room.id, room);
  }

  const worldIds = [
    ...new Set(
      sourceRooms
        .map((room) => room.worldId)
        .filter((worldId): worldId is UUID => Boolean(worldId)),
    ),
  ];
  const worlds = await Promise.all(worldIds.map((id) => runtime.getWorld(id)));
  const worldMap = new Map<string, World>();
  for (const world of worlds) {
    if (world) {
      worldMap.set(world.id, world);
    }
  }

  const messagesByRoom = new Map<string, typeof filtered>();
  for (const m of filtered) {
    const arr = messagesByRoom.get(m.roomId) ?? [];
    arr.push(m);
    messagesByRoom.set(m.roomId, arr);
  }

  // Fetch participant counts per room exactly once. Used to classify groups
  // vs public channels and to filter out >15-person rooms in the inbox.
  const participantCountByRoom = new Map<string, number>();
  await Promise.all(
    sourceRooms.map(async (room) => {
      const ids = await runtime.getParticipantsForRoom(room.id);
      participantCountByRoom.set(room.id, ids.length);
    }),
  );

  const results: InboundMessage[] = [];
  for (const memory of filtered.slice(0, limit)) {
    const room = roomMap.get(memory.roomId);
    const source = normalizeConnectorSource(extractMemorySource(memory) ?? "");
    const text = extractText(memory);
    if (!text) continue;

    const senderName = extractSenderName(memory) ?? "Unknown";
    const channelName = resolveChannelName(source, room?.name, senderName);
    const channelType = detectChannelType(room);
    const participantCount = participantCountByRoom.get(memory.roomId);
    const chatType = classifyChatType(room, channelType, participantCount);
    const world = room?.worldId ? worldMap.get(room.worldId) : undefined;
    const deepLink = await buildDeepLink(runtime, source, {
      roomId: memory.roomId,
      messageId: memory.id,
      roomMeta: metadataForRoom(room),
      worldMeta: metadataForWorld(world),
    });

    const roomMessages = messagesByRoom.get(memory.roomId) ?? [];
    const threadMessages = roomMessages
      .filter(
        (m) =>
          m.id !== memory.id && (m.createdAt ?? 0) <= (memory.createdAt ?? 0),
      )
      .slice(0, THREAD_CONTEXT_LIMIT)
      .map((m) => {
        const name = extractSenderName(m) ?? "Unknown";
        return `${name}: ${extractText(m).slice(0, 100)}`;
      });

    results.push({
      id:
        memory.id ??
        `${source}:${memory.roomId}:${memory.createdAt ?? Date.now()}:${results.length}`,
      source,
      roomId: memory.roomId,
      entityId: memory.entityId,
      senderName,
      channelName,
      channelType,
      text,
      snippet: text.slice(0, SNIPPET_MAX_LENGTH),
      timestamp: memory.createdAt ?? Date.now(),
      deepLink: deepLink ?? undefined,
      threadMessages: threadMessages.length > 0 ? threadMessages : undefined,
      threadId: memory.roomId,
      chatType,
      participantCount,
    });
  }

  return results;
}

export async function fetchGmailMessages(
  source: GmailInboxSource,
  opts: {
    sinceIso?: string;
    limit?: number;
    /** Filter to a single Gmail account by Google grant id. */
    grantId?: string;
  },
): Promise<InboundMessage[]> {
  const status = await source.getGoogleConnectorStatus(INTERNAL_URL);
  if (!status.connected) return [];
  const capabilities = status.grantedCapabilities ?? [];
  if (!capabilities.includes("google.gmail.triage")) return [];

  // When no grantId is supplied, the service-side getGmailTriage already
  // aggregates across every Google grant and tags each summary with grantId
  // and accountEmail. We forward those onto the InboundMessage so the inbox
  // mixin can group by account and render account chips.
  const triageFeed = await source.getGmailTriage(
    INTERNAL_URL,
    opts.grantId ? { grantId: opts.grantId } : undefined,
  );
  if (triageFeed.messages.length === 0) return [];

  const limit = opts.limit ?? 50;
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : 0;

  const results: InboundMessage[] = [];
  for (const msg of triageFeed.messages.slice(0, limit)) {
    const receivedMs = Date.parse(String(msg.receivedAt));
    if (sinceMs > 0 && receivedMs < sinceMs) continue;

    const from = msg.from || msg.fromEmail || "Unknown sender";
    const gmailLink =
      msg.htmlLink ??
      (msg.externalId
        ? `https://mail.google.com/mail/u/0/#inbox/${msg.externalId}`
        : undefined);

    results.push({
      id: msg.id || `gmail-${Date.now()}-${results.length}`,
      source: "gmail",
      senderName: from,
      senderEmail: msg.fromEmail ?? undefined,
      channelName: `Email from ${from}`,
      channelType: "dm",
      text: msg.snippet || msg.subject || "",
      snippet: (msg.snippet || msg.subject || "").slice(0, SNIPPET_MAX_LENGTH),
      timestamp: receivedMs,
      deepLink: gmailLink ?? undefined,
      gmailMessageId: msg.externalId || msg.id,
      gmailIsImportant: msg.isImportant ?? false,
      gmailLikelyReplyNeeded: msg.likelyReplyNeeded ?? false,
      threadId: msg.threadId,
      chatType: "dm",
      gmailAccountId: msg.grantId,
      gmailAccountEmail: msg.accountEmail ?? undefined,
    });
  }

  return results;
}

export async function fetchXDmMessages(
  source: XDmInboxSource,
  opts: {
    sinceIso?: string;
    limit?: number;
  },
): Promise<InboundMessage[]> {
  const status = await source.getXConnectorStatus();
  if (!status.connected || !status.dmRead) return [];

  const limit = opts.limit ?? 50;
  await source.syncXDms({ limit });
  const dms = await source.getXDms({ limit });
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : 0;
  const results: InboundMessage[] = [];

  for (const dm of dms) {
    if (!dm.isInbound) continue;
    const receivedMs = Date.parse(dm.receivedAt);
    if (sinceMs > 0 && receivedMs < sinceMs) continue;
    const sender = dm.senderHandle ? `@${dm.senderHandle}` : dm.senderId;
    const metadata = dm.metadata ?? {};
    const participantIds = Array.isArray(metadata.participantIds)
      ? metadata.participantIds.filter(
          (participantId): participantId is string =>
            typeof participantId === "string",
        )
      : [];
    const participantId =
      typeof metadata.participantId === "string" &&
      metadata.participantId.trim()
        ? metadata.participantId.trim()
        : dm.senderId;
    const isGroup = participantIds.length > 2;
    const xParticipantCount = participantIds.length || (isGroup ? undefined : 2);
    results.push({
      id: dm.id,
      source: "x_dm",
      entityId: participantId,
      xConversationId: dm.conversationId,
      xParticipantId: participantId,
      senderName: sender || "X user",
      channelName: isGroup ? "X group DM" : `X DM from ${sender || "unknown"}`,
      channelType: isGroup ? "group" : "dm",
      text: dm.text,
      snippet: dm.text.slice(0, SNIPPET_MAX_LENGTH),
      timestamp: Number.isFinite(receivedMs) ? receivedMs : Date.now(),
      threadId: dm.conversationId,
      chatType: isGroup ? "group" : "dm",
      participantCount: xParticipantCount,
    });
  }

  return results;
}

export async function fetchAllMessages(
  runtime: IAgentRuntime,
  opts: {
    sources?: string[];
    sinceIso?: string;
    limit?: number;
    includeGmail?: boolean;
    gmailSource?: GmailInboxSource;
    xDmSource?: XDmInboxSource;
    /** Filter Gmail to a single account by Google grant id. */
    gmailGrantId?: string;
  },
): Promise<InboundMessage[]> {
  const includeGmail =
    opts.includeGmail !== false &&
    (!opts.sources || opts.sources.includes("gmail"));
  const gmailMessagesPromise = includeGmail
    ? opts.gmailSource
      ? fetchGmailMessages(opts.gmailSource, {
          sinceIso: opts.sinceIso,
          limit: opts.limit,
          grantId: opts.gmailGrantId,
        })
      : Promise.reject(
          new Error(
            "fetchAllMessages requires gmailSource when Gmail is included",
          ),
        )
    : Promise.resolve([]);
  const xDmMessagesPromise =
    opts.xDmSource && (!opts.sources || opts.sources.includes("x_dm"))
      ? fetchXDmMessages(opts.xDmSource, {
          sinceIso: opts.sinceIso,
          limit: opts.limit,
        })
      : Promise.resolve([]);

  const [chatMessages, gmailMessages, xDmMessages] = await Promise.all([
    fetchChatMessages(runtime, {
      sources: opts.sources?.filter((s) => s !== "gmail" && s !== "x_dm"),
      sinceIso: opts.sinceIso,
      limit: opts.limit,
    }),
    gmailMessagesPromise,
    xDmMessagesPromise,
  ]);

  const combined = [...chatMessages, ...gmailMessages, ...xDmMessages];
  combined.sort((a, b) => b.timestamp - a.timestamp);
  return opts.limit ? combined.slice(0, opts.limit) : combined;
}

function extractMemorySource(memory: Memory): string | null {
  const content = memory.content as { source?: unknown } | undefined;
  const source = content?.source;
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractText(memory: Memory): string {
  const content = memory.content as { text?: unknown } | undefined;
  const text = content?.text;
  return typeof text === "string" ? text : "";
}

function extractSenderName(memory: Memory): string | null {
  const meta = memory.metadata as Record<string, unknown> | undefined;
  const entityName = meta?.entityName;
  if (typeof entityName === "string" && entityName.length > 0) {
    return entityName;
  }
  return null;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function metadataForRoom(room: Room | undefined): Record<string, unknown> {
  if (!room) return {};
  return {
    ...metadataRecord(room.metadata),
    roomId: room.id,
    roomName: room.name,
    serverId: room.serverId,
  };
}

function metadataForWorld(world: World | undefined): Record<string, unknown> {
  return world ? metadataRecord(world.metadata) : {};
}

function extractRoomSource(room: Room): string | null {
  const source = (room as Room & { source?: unknown }).source;
  if (typeof source === "string" && source.trim().length > 0) {
    return normalizeConnectorSource(source.trim());
  }
  return null;
}

function detectChannelType(room: Room | undefined): "dm" | "group" {
  if (!room) return "dm";
  const type = room.type;
  if (typeof type === "string") {
    const lower = type.toLowerCase();
    if (lower.includes("dm") || lower.includes("direct")) return "dm";
    if (lower.includes("group") || lower.includes("channel")) return "group";
  }
  return "dm";
}

/**
 * Classify a room as DM, small group, or public channel/broadcast.
 * Discord text channels (`GUILD_TEXT`, `voice`, etc.) are treated as channels.
 * Anything with more than {@link PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD}
 * participants is also treated as a channel so the inbox can hide it.
 */
function classifyChatType(
  room: Room | undefined,
  channelType: "dm" | "group",
  participantCount: number | undefined,
): "dm" | "group" | "channel" {
  const rawType =
    typeof room?.type === "string" ? room.type.toLowerCase() : "";
  const isLikelyPublicChannel =
    rawType.includes("guild") ||
    rawType.includes("voice") ||
    rawType.includes("forum") ||
    rawType.includes("public") ||
    rawType.includes("broadcast");
  if (channelType === "dm") {
    return "dm";
  }
  if (
    isLikelyPublicChannel ||
    (typeof participantCount === "number" &&
      participantCount > PUBLIC_CHANNEL_PARTICIPANT_THRESHOLD)
  ) {
    return "channel";
  }
  return "group";
}
