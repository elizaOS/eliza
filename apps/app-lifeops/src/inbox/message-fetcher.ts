import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import {
  expandConnectorSourceFilter,
  normalizeConnectorSource,
} from "@elizaos/shared/connectors";
import type {
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import { buildDeepLink, resolveChannelName } from "./channel-deep-links.js";
import type { InboundMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  getGoogleConnectorStatus(requestUrl: URL): Promise<LifeOpsGoogleConnectorStatus>;
  getGmailTriage(requestUrl: URL): Promise<LifeOpsGmailTriageFeed>;
}

// ---------------------------------------------------------------------------
// Chat channel fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch recent inbound messages from chat connector channels.
 * Mirrors the room-scanning approach in inbox-routes.ts but normalises
 * output into InboundMessage[] for the triage pipeline.
 */
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
    opts.sources ?? (DEFAULT_SOURCES as unknown as string[]),
  );
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : 0;

  // 1. Gather rooms the agent participates in
  const allRoomIds = await runtime.getRoomsForParticipant(runtime.agentId);
  if (allRoomIds.length === 0) return [];

  // 2. Resolve rooms and filter by source
  const roomIds = allRoomIds.slice(0, MAX_ROOMS_SCANNED) as UUID[];
  const rooms = await Promise.all(
    roomIds.map((id) => runtime.getRoom(id).catch(() => null)),
  );
  const sourceRooms: Room[] = [];
  for (const room of rooms) {
    if (!room) continue;
    const roomSource = extractRoomSource(room);
    if (roomSource && sourceTags.has(roomSource)) {
      sourceRooms.push(room);
    }
  }

  if (sourceRooms.length === 0) return [];

  // 3. Fetch recent memories from matching rooms
  const sourceRoomIds = sourceRooms.map((r) => r.id) as UUID[];
  const memories = await runtime.getMemoriesByRoomIds({
    roomIds: sourceRoomIds,
    tableName: "messages",
    limit: limit * 3, // over-fetch for filtering
  });

  // 4. Filter to inbound messages (not from agent, after since, with source)
  const filtered = memories.filter((m) => {
    if (m.entityId === runtime.agentId) return false;
    if (sinceMs > 0 && (m.createdAt ?? 0) < sinceMs) return false;
    const src = extractMemorySource(m);
    return src !== null && sourceTags.has(src);
  });

  // Sort newest first
  filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  // 5. Build room lookup for metadata
  const roomMap = new Map<string, Room>();
  for (const room of sourceRooms) {
    roomMap.set(room.id, room);
  }

  // 6. Build room-based index for thread context (avoids O(n^2) filter)
  const messagesByRoom = new Map<string, typeof filtered>();
  for (const m of filtered) {
    const arr = messagesByRoom.get(m.roomId) ?? [];
    arr.push(m);
    messagesByRoom.set(m.roomId, arr);
  }

  // 7. Normalise into InboundMessage[]
  const results: InboundMessage[] = [];
  for (const memory of filtered.slice(0, limit)) {
    const room = roomMap.get(memory.roomId);
    const source = normalizeConnectorSource(extractMemorySource(memory) ?? "");
    const text = extractText(memory);
    if (!text) continue;

    const senderName = extractSenderName(memory) ?? "Unknown";
    const channelName = await resolveChannelName(
      runtime,
      source,
      memory.roomId,
      senderName,
    );
    const channelType = detectChannelType(room);
    const deepLink = await buildDeepLink(runtime, source, {
      roomId: memory.roomId,
      entityId: memory.entityId,
      messageId: memory.id,
    });

    // Gather recent thread context (up to THREAD_CONTEXT_LIMIT previous messages)
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
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Gmail fetcher (delegates to lifeops service)
// ---------------------------------------------------------------------------

/**
 * Fetch recent Gmail triage data from an explicit service source.
 * Returns normalised InboundMessage[] from the email triage feed.
 */
export async function fetchGmailMessages(
  source: GmailInboxSource,
  opts: {
    sinceIso?: string;
    limit?: number;
  },
): Promise<InboundMessage[]> {
  const status = await source.getGoogleConnectorStatus(INTERNAL_URL);
  if (!status.connected) return [];
  const capabilities = status.grantedCapabilities ?? [];
  if (!capabilities.includes("google.gmail.triage")) return [];

  const triageFeed = await source.getGmailTriage(INTERNAL_URL);
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
      channelName: `Email from ${from}`,
      channelType: "dm",
      text: msg.snippet || msg.subject || "",
      snippet: (msg.snippet || msg.subject || "").slice(
        0,
        SNIPPET_MAX_LENGTH,
      ),
      timestamp: receivedMs,
      deepLink: gmailLink ?? undefined,
      gmailMessageId: msg.externalId || msg.id,
      gmailIsImportant: msg.isImportant ?? false,
      gmailLikelyReplyNeeded: msg.likelyReplyNeeded ?? false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Combined fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch inbound messages from all configured channels.
 */
export async function fetchAllMessages(
  runtime: IAgentRuntime,
  opts: {
    sources?: string[];
    sinceIso?: string;
    limit?: number;
    includeGmail?: boolean;
    gmailSource?: GmailInboxSource;
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
        })
      : Promise.reject(
          new Error("fetchAllMessages requires gmailSource when Gmail is included"),
        )
    : Promise.resolve([]);

  const [chatMessages, gmailMessages] = await Promise.all([
    fetchChatMessages(runtime, {
      sources: opts.sources?.filter((s) => s !== "gmail"),
      sinceIso: opts.sinceIso,
      limit: opts.limit,
    }),
    gmailMessagesPromise,
  ]);

  const combined = [...chatMessages, ...gmailMessages];
  // Sort by timestamp descending (newest first)
  combined.sort((a, b) => b.timestamp - a.timestamp);
  return opts.limit ? combined.slice(0, opts.limit) : combined;
}

// ---------------------------------------------------------------------------
// Memory extraction helpers
// ---------------------------------------------------------------------------

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

function extractRoomSource(room: Room): string | null {
  const record = room as unknown as Record<string, unknown>;
  const source = record.source;
  if (typeof source === "string" && source.trim().length > 0) {
    return normalizeConnectorSource(source.trim());
  }
  return null;
}

function detectChannelType(room: Room | undefined): "dm" | "group" {
  if (!room) return "dm";
  const record = room as unknown as Record<string, unknown>;
  const type = record.type ?? record.roomType ?? record.room_type;
  if (typeof type === "string") {
    const lower = type.toLowerCase();
    if (lower.includes("dm") || lower.includes("direct")) return "dm";
    if (lower.includes("group") || lower.includes("channel")) return "group";
  }
  return "dm";
}
