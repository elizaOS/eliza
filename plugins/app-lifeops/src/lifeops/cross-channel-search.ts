/**
 * Cross-channel search (WS1).
 *
 * Fans a single semantic query across:
 *   - Gmail (via LifeOpsService.getGmailSearch)
 *   - Agent memory (runtime.searchMemories with embedding)
 *   - WS3 RelationshipsGraphService.getMemoriesForCluster (when a personRef
 *     resolves to a canonical cluster)
 *
 * Connectors that lack first-class search emit a typed `unsupported`
 * result. We never fabricate hits.
 *
 * Architecture note: this file is the orchestrator. The action
 * (search-across-channels.ts) handles LLM param extraction and result
 * formatting. The provider (cross-channel-context.ts) consumes
 * runCrossChannelSearch() to inject context for named persons/topics.
 */

// WS3 dependency — types may not yet be exported from agent index when this
// file is first compiled. Importing from the source path so type-only
// resolution succeeds even before the public re-export lands.
import {
  getMemoriesForCluster as getClusterMemories,
  type RelationshipsGraphService,
  type RelationshipsPersonSummary,
  resolveRelationshipsGraphService,
} from "@elizaos/agent/services/relationships-graph";
import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsGmailMessageSummary,
  LifeOpsXDm,
  LifeOpsXFeedItem,
} from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const CROSS_CHANNEL_SEARCH_CHANNELS = [
  "gmail",
  "memory",
  "telegram",
  "discord",
  "imessage",
  "whatsapp",
  "signal",
  "x",
  "x-dm",
  "calendly",
  "calendar",
] as const;

export type CrossChannelSearchChannel =
  (typeof CROSS_CHANNEL_SEARCH_CHANNELS)[number];

export type CrossChannelSearchTimeWindow = {
  /** ISO timestamp lower bound (inclusive). */
  startIso?: string;
  /** ISO timestamp upper bound (inclusive). */
  endIso?: string;
};

export type CrossChannelSearchPersonRef = {
  /** Canonical cluster primary entity id (preferred). */
  primaryEntityId?: UUID;
  /** Free-form display name from LLM extraction (fallback). */
  displayName?: string;
};

export type CrossChannelSearchQuery = {
  /** Free-form semantic query — required, no fallback default. */
  query: string;
  /** Optional named person to focus the search on. */
  personRef?: CrossChannelSearchPersonRef;
  /** Optional ISO time window to bound results. */
  timeWindow?: CrossChannelSearchTimeWindow;
  /** Optional explicit channel allowlist; default = all known channels. */
  channels?: CrossChannelSearchChannel[];
  /** Optional worldId scope for memory search. */
  worldId?: UUID;
  /** Per-channel hit cap (default 10). */
  limit?: number;
};

export type CrossChannelSearchHit = {
  channel: CrossChannelSearchChannel;
  /** Stable id for dedup + citation. */
  id: string;
  /** Source room id for memory hits, gmail message id for gmail, etc. */
  sourceRef: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Sender / from. */
  speaker: string;
  /** Free-form text body (already trimmed). */
  text: string;
  /** Optional subject (gmail). */
  subject?: string;
  /** Provenance for the citation. */
  citation: {
    platform: string;
    label: string;
    url?: string;
  };
};

export type CrossChannelSearchUnsupported = {
  channel: CrossChannelSearchChannel;
  reason: string;
};

export type CrossChannelSearchDegraded = {
  channel: CrossChannelSearchChannel;
  reason: string;
};

export type CrossChannelSearchResult = {
  query: string;
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
  degraded: CrossChannelSearchDegraded[];
  /** Channels that produced at least one hit. */
  channelsWithHits: CrossChannelSearchChannel[];
  /** Resolved canonical person, when available from WS3. */
  resolvedPerson: RelationshipsPersonSummary | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PER_CHANNEL_LIMIT = 10;
const MEMORY_MATCH_THRESHOLD = 0.55;

const KNOWN_PLATFORM_FOR_CHANNEL: Record<CrossChannelSearchChannel, string> = {
  gmail: "gmail",
  memory: "memory",
  telegram: "telegram",
  discord: "discord",
  imessage: "imessage",
  whatsapp: "whatsapp",
  signal: "signal",
  x: "x",
  "x-dm": "x",
  calendly: "calendly",
  calendar: "calendar",
};

function withinTimeWindow(
  iso: string | undefined,
  window: CrossChannelSearchTimeWindow | undefined,
): boolean {
  if (!window || (!window.startIso && !window.endIso)) {
    return true;
  }
  if (!iso) {
    return false;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return false;
  }
  if (window.startIso) {
    const start = Date.parse(window.startIso);
    if (!Number.isNaN(start) && t < start) {
      return false;
    }
  }
  if (window.endIso) {
    const end = Date.parse(window.endIso);
    if (!Number.isNaN(end) && t > end) {
      return false;
    }
  }
  return true;
}

function normalizeIsoFromMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return new Date(0).toISOString();
  }
  return new Date(ms).toISOString();
}

function classifyMemoryChannel(
  source: string | undefined,
): CrossChannelSearchChannel {
  const normalized = (source ?? "").trim().toLowerCase();
  switch (normalized) {
    case "telegram":
      return "telegram";
    case "discord":
      return "discord";
    case "imessage":
    case "messages":
      return "imessage";
    case "whatsapp":
      return "whatsapp";
    case "signal":
      return "signal";
    case "x":
    case "twitter":
      return "x";
    case "x-dm":
      return "x-dm";
    case "calendly":
      return "calendly";
    case "calendar":
    case "google-calendar":
      return "calendar";
    case "gmail":
    case "google-gmail":
    case "email":
      return "gmail";
    default:
      return "memory";
  }
}

function isChannelEnabled(
  channel: CrossChannelSearchChannel,
  channels: CrossChannelSearchChannel[] | undefined,
): boolean {
  if (!channels || channels.length === 0) {
    return true;
  }
  return channels.includes(channel);
}

// ---------------------------------------------------------------------------
// Per-channel adapters
// ---------------------------------------------------------------------------

type GmailSearchService = {
  getGmailSearch: (
    requestUrl: URL,
    request: { query: string; maxResults?: number },
  ) => Promise<{ messages: LifeOpsGmailMessageSummary[] }>;
};

type TelegramMessageSearchResult = {
  id: string | null;
  dialogId: string | null;
  dialogTitle: string | null;
  username: string | null;
  content: string;
  timestamp: string | null;
  outgoing: boolean;
};

type DiscordMessageSearchResult = {
  id: string | null;
  content: string;
  authorName: string | null;
  channelId: string | null;
  timestamp: string | null;
};

type IMessageSearchResult = {
  id: string;
  fromHandle: string;
  toHandles: string[];
  text: string;
  isFromMe: boolean;
  sentAt: string;
  chatId?: string;
};

type CrossChannelNativeSearchService = GmailSearchService & {
  searchTelegramMessages?: (request: {
    query: string;
    scope?: string;
    limit?: number;
  }) => Promise<TelegramMessageSearchResult[]>;
  searchDiscordMessages?: (request: {
    query: string;
    channelId?: string;
  }) => Promise<DiscordMessageSearchResult[]>;
  searchIMessages?: (request: {
    query: string;
    chatId?: string;
    limit?: number;
  }) => Promise<IMessageSearchResult[]>;
  readSignalInbound?: (limit?: number) => Promise<
    Array<{
      id: string;
      threadId?: string | null;
      roomName?: string | null;
      speakerName?: string | null;
      senderNumber?: string | null;
      createdAt: number;
      text: string;
    }>
  >;
  pullWhatsAppRecent?: (limit?: number) => {
    count: number;
    messages: Array<{
      id: string;
      from: string;
      channelId: string;
      timestamp: string;
      text?: string;
      metadata?: { contactName?: string };
    }>;
  };
  getCalendarFeed?: (
    requestUrl: URL,
    request: {
      timeMin?: string;
      timeMax?: string;
      includeHiddenCalendars?: boolean;
    },
  ) => Promise<{ events: LifeOpsCalendarEvent[] }>;
  searchXPosts?: (
    query: string,
    opts?: { limit?: number },
  ) => Promise<LifeOpsXFeedItem[]>;
  getXDms?: (opts?: {
    conversationId?: string;
    limit?: number;
  }) => Promise<LifeOpsXDm[]>;
};

function getLifeOpsSearchService(
  runtime: IAgentRuntime,
): CrossChannelNativeSearchService | null {
  return runtime.getService(
    "lifeops",
  ) as unknown as CrossChannelNativeSearchService | null;
}

async function searchGmail(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
  degraded: CrossChannelSearchDegraded[];
}> {
  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.getGmailSearch !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "gmail",
          reason: "LifeOpsService not registered on runtime",
        },
      ],
      degraded: [],
    };
  }

  const requestUrl = new URL("http://127.0.0.1/api/lifeops/gmail/search");
  const feed = await lifeOps.getGmailSearch(requestUrl, {
    query: query.query,
    maxResults: limit,
  });

  const hits: CrossChannelSearchHit[] = [];
  for (const msg of feed.messages) {
    if (!withinTimeWindow(msg.receivedAt, query.timeWindow)) {
      continue;
    }
    hits.push({
      channel: "gmail",
      id: `gmail:${msg.id}`,
      sourceRef: msg.id,
      timestamp: msg.receivedAt,
      speaker: msg.from,
      subject: msg.subject,
      text: msg.snippet,
      citation: {
        platform: "gmail",
        label: msg.subject || msg.snippet.slice(0, 80),
        url: msg.htmlLink ?? undefined,
      },
    });
  }
  return { hits, unsupported: [], degraded: [] };
}

async function searchTelegram(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.searchTelegramMessages !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "telegram",
          reason: "Telegram search is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const messages = await lifeOps.searchTelegramMessages({
    query: query.query,
    limit,
  });
  const hits: CrossChannelSearchHit[] = [];
  for (const msg of messages) {
    if (!withinTimeWindow(msg.timestamp ?? undefined, query.timeWindow)) {
      continue;
    }
    const sourceRef = msg.id ?? msg.dialogId ?? msg.content.slice(0, 48);
    hits.push({
      channel: "telegram",
      id: `telegram:${sourceRef}`,
      sourceRef,
      timestamp: msg.timestamp ?? new Date(0).toISOString(),
      speaker: msg.outgoing ? "me" : (msg.username ?? "unknown"),
      text: msg.content,
      citation: {
        platform: "telegram",
        label: msg.dialogTitle ?? msg.username ?? "Telegram",
      },
    });
  }
  return { hits, unsupported: [] };
}

async function searchDiscord(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.searchDiscordMessages !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "discord",
          reason: "Discord search is not available on LifeOpsService",
        },
      ],
    };
  }

  const messages = await lifeOps.searchDiscordMessages({ query: query.query });
  const hits: CrossChannelSearchHit[] = [];
  for (const msg of messages) {
    if (!withinTimeWindow(msg.timestamp ?? undefined, query.timeWindow)) {
      continue;
    }
    const sourceRef = msg.id ?? msg.channelId ?? msg.content.slice(0, 48);
    hits.push({
      channel: "discord",
      id: `discord:${sourceRef}`,
      sourceRef,
      timestamp: msg.timestamp ?? new Date(0).toISOString(),
      speaker: msg.authorName ?? "unknown",
      text: msg.content,
      citation: {
        platform: "discord",
        label: msg.channelId ? `channel:${msg.channelId}` : "Discord",
      },
    });
  }
  return { hits, unsupported: [] };
}

async function searchIMessages(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.searchIMessages !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "imessage",
          reason: "iMessage search is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const messages = await lifeOps.searchIMessages({
    query: query.query,
    limit,
  });
  const hits: CrossChannelSearchHit[] = [];
  for (const msg of messages) {
    if (!withinTimeWindow(msg.sentAt, query.timeWindow)) {
      continue;
    }
    hits.push({
      channel: "imessage",
      id: `imessage:${msg.id}`,
      sourceRef: msg.id,
      timestamp: msg.sentAt,
      speaker: msg.isFromMe ? "me" : msg.fromHandle,
      text: msg.text,
      citation: {
        platform: "imessage",
        label: msg.chatId ?? msg.fromHandle,
      },
    });
  }
  return { hits, unsupported: [] };
}

async function searchSignal(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.readSignalInbound !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "signal",
          reason: "Signal passive read is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const needle = query.query.trim().toLowerCase();
  const messages = await lifeOps.readSignalInbound(limit + 25);
  const hits: CrossChannelSearchHit[] = [];
  for (const msg of messages) {
    const timestamp = normalizeIsoFromMs(msg.createdAt);
    if (!withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    if (needle && !msg.text.toLowerCase().includes(needle)) {
      continue;
    }
    hits.push({
      channel: "signal",
      id: `signal:${msg.id}`,
      sourceRef: msg.id,
      timestamp,
      speaker: msg.speakerName ?? msg.senderNumber ?? "unknown",
      text: msg.text,
      citation: {
        platform: "signal",
        label: msg.roomName ?? msg.threadId ?? "Signal",
      },
    });
  }
  return { hits: hits.slice(0, limit), unsupported: [] };
}

async function searchWhatsApp(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.pullWhatsAppRecent !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "whatsapp",
          reason: "WhatsApp passive read is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const needle = query.query.trim().toLowerCase();
  const recent = lifeOps.pullWhatsAppRecent(limit + 25);
  const hits: CrossChannelSearchHit[] = [];
  for (const msg of recent.messages) {
    const text = msg.text?.trim();
    if (!text) {
      continue;
    }
    if (!withinTimeWindow(msg.timestamp, query.timeWindow)) {
      continue;
    }
    if (needle && !text.toLowerCase().includes(needle)) {
      continue;
    }
    hits.push({
      channel: "whatsapp",
      id: `whatsapp:${msg.id}`,
      sourceRef: msg.id,
      timestamp: msg.timestamp,
      speaker: msg.metadata?.contactName ?? msg.from,
      text,
      citation: {
        platform: "whatsapp",
        label: msg.metadata?.contactName ?? msg.channelId,
      },
    });
  }
  return { hits: hits.slice(0, limit), unsupported: [] };
}

function searchableCalendarText(event: LifeOpsCalendarEvent): string {
  return [
    event.title,
    event.description,
    event.location,
    event.organizer && typeof event.organizer === "object"
      ? JSON.stringify(event.organizer)
      : "",
    ...event.attendees.map((attendee) =>
      [attendee.displayName, attendee.email].filter(Boolean).join(" "),
    ),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

async function searchCalendar(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.getCalendarFeed !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "calendar",
          reason: "Calendar feed is not available on LifeOpsService",
        },
      ],
    };
  }

  const feed = await lifeOps.getCalendarFeed(
    new URL("http://127.0.0.1/api/lifeops/calendar/feed"),
    {
      timeMin: query.timeWindow?.startIso,
      timeMax: query.timeWindow?.endIso,
      includeHiddenCalendars: true,
    },
  );
  const needle = query.query.trim().toLowerCase();
  const hits: CrossChannelSearchHit[] = [];
  for (const event of feed.events) {
    if (!withinTimeWindow(event.startAt, query.timeWindow)) {
      continue;
    }
    if (needle && !searchableCalendarText(event).includes(needle)) {
      continue;
    }
    const organizer =
      event.organizer && typeof event.organizer === "object"
        ? (event.organizer as { displayName?: unknown; email?: unknown })
        : null;
    hits.push({
      channel: "calendar",
      id: `calendar:${event.id}`,
      sourceRef: event.id,
      timestamp: event.startAt,
      speaker:
        typeof organizer?.displayName === "string"
          ? organizer.displayName
          : typeof organizer?.email === "string"
            ? organizer.email
            : "calendar",
      subject: event.title,
      text: [event.title, event.description, event.location]
        .filter(Boolean)
        .join(" — "),
      citation: {
        platform: "calendar",
        label: event.title,
        url: event.htmlLink ?? event.conferenceLink ?? undefined,
      },
    });
  }
  return { hits, unsupported: [] };
}

function xStatusUrl(item: LifeOpsXFeedItem): string | undefined {
  const tweetId = item.externalTweetId.trim();
  if (!tweetId) return undefined;
  const handle = item.authorHandle.replace(/^@/, "").trim();
  return handle
    ? `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(tweetId)}`
    : `https://x.com/i/web/status/${encodeURIComponent(tweetId)}`;
}

async function searchXPostsChannel(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.searchXPosts !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "x",
          reason: "X post search is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const posts = await lifeOps.searchXPosts(query.query, { limit });
  const hits: CrossChannelSearchHit[] = [];
  for (const post of posts) {
    if (!withinTimeWindow(post.createdAtSource, query.timeWindow)) {
      continue;
    }
    hits.push({
      channel: "x",
      id: `x:${post.externalTweetId || post.id}`,
      sourceRef: post.id,
      timestamp: post.createdAtSource,
      speaker: post.authorHandle,
      text: post.text,
      citation: {
        platform: "x",
        label: post.authorHandle,
        url: xStatusUrl(post),
      },
    });
  }
  return { hits, unsupported: [] };
}

async function searchXDms(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  unsupported: CrossChannelSearchUnsupported[];
}> {
  const lifeOps = getLifeOpsSearchService(runtime);
  if (!lifeOps || typeof lifeOps.getXDms !== "function") {
    return {
      hits: [],
      unsupported: [
        {
          channel: "x-dm",
          reason: "X DM search is not available on LifeOpsService",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const needle = query.query.trim().toLowerCase();
  const dms = await lifeOps.getXDms({ limit: limit + 10 });
  const hits: CrossChannelSearchHit[] = [];
  for (const dm of dms) {
    if (!withinTimeWindow(dm.receivedAt, query.timeWindow)) {
      continue;
    }
    if (needle && !dm.text.toLowerCase().includes(needle)) {
      continue;
    }
    hits.push({
      channel: "x-dm",
      id: `x-dm:${dm.id}`,
      sourceRef: dm.id,
      timestamp: dm.receivedAt,
      speaker: dm.isInbound ? dm.senderHandle : "me",
      text: dm.text,
      citation: {
        platform: "x",
        label: dm.senderHandle || dm.conversationId,
      },
    });
  }
  return { hits: hits.slice(0, limit), unsupported: [] };
}

async function embedQuery(
  runtime: IAgentRuntime,
  text: string,
): Promise<number[] | null> {
  const result = await runWithTrajectoryContext(
    { purpose: "lifeops-cross-channel-search-embedding" },
    () => runtime.useModel(ModelType.TEXT_EMBEDDING, { text }),
  );
  if (Array.isArray(result)) {
    return result;
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { embedding?: unknown }).embedding)
  ) {
    return (result as { embedding: number[] }).embedding;
  }
  return null;
}

async function searchAgentMemory(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  degraded: CrossChannelSearchDegraded[];
}> {
  const embedding = await embedQuery(runtime, query.query);
  if (!embedding) {
    return {
      hits: [],
      degraded: [
        {
          channel: "memory",
          reason: "Embedding generation returned no vector",
        },
      ],
    };
  }

  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const searchParams: Parameters<IAgentRuntime["searchMemories"]>[0] = {
    embedding,
    tableName: "messages",
    match_threshold: MEMORY_MATCH_THRESHOLD,
    limit: limit + 10,
    worldId: query.worldId,
  };

  const memories = await runtime.searchMemories(searchParams);
  const hits = await memoriesToHits(runtime, memories, query);
  return { hits, degraded: [] };
}

async function memoriesToHits(
  runtime: IAgentRuntime,
  memories: Memory[],
  query: CrossChannelSearchQuery,
): Promise<CrossChannelSearchHit[]> {
  const roomCache = new Map<string, Room | null>();
  const results: CrossChannelSearchHit[] = [];

  for (const mem of memories) {
    const text = (mem.content?.text ?? "").trim();
    if (!text) continue;

    const iso = normalizeIsoFromMs(mem.createdAt);
    if (!withinTimeWindow(iso, query.timeWindow)) {
      continue;
    }

    const roomId = mem.roomId as UUID | undefined;
    let room: Room | null = null;
    if (roomId) {
      if (!roomCache.has(roomId)) {
        const fetched = await runtime.getRoom(roomId);
        roomCache.set(roomId, fetched ?? null);
      }
      room = roomCache.get(roomId) ?? null;
    }

    const roomRecord = room as
      | (Room & { name?: string; source?: string })
      | null;
    const platformSource = roomRecord?.source ?? roomRecord?.type;
    const channel = classifyMemoryChannel(platformSource);

    if (!isChannelEnabled(channel, query.channels)) {
      continue;
    }

    const speakerEntity = mem.entityId as string | undefined;
    const memId =
      (mem.id as string | undefined) ?? `${roomId}:${mem.createdAt}`;

    results.push({
      channel,
      id: `${channel}:${memId}`,
      sourceRef: memId,
      timestamp: iso,
      speaker: speakerEntity ?? "unknown",
      text: text.slice(0, 600),
      citation: {
        platform: KNOWN_PLATFORM_FOR_CHANNEL[channel],
        label: roomRecord?.name ?? `room:${(roomId ?? "").slice(0, 8)}`,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// WS3 cluster fan-out
// ---------------------------------------------------------------------------

// WS3 plans to publish this on RelationshipsGraphService. Until the type is
// committed upstream we encode the expected signature locally.
type GetMemoriesForClusterFn = (args: {
  primaryEntityId: UUID;
  count?: number;
  worldId?: UUID;
}) => Promise<Memory[]>;

type RelationshipsGraphServiceWithCluster = RelationshipsGraphService & {
  getMemoriesForCluster?: GetMemoriesForClusterFn;
};

async function resolvePerson(
  runtime: IAgentRuntime,
  ref: CrossChannelSearchPersonRef | undefined,
): Promise<{
  service: RelationshipsGraphServiceWithCluster | null;
  person: RelationshipsPersonSummary | null;
  degraded: CrossChannelSearchDegraded[];
}> {
  if (!ref) {
    return { service: null, person: null, degraded: [] };
  }

  const baseService = (await resolveRelationshipsGraphService(
    runtime,
  )) as RelationshipsGraphServiceWithCluster | null;
  const service = baseService
    ? ({
        ...baseService,
        getMemoriesForCluster:
          baseService.getMemoriesForCluster ??
          ((args) =>
            getClusterMemories(runtime, args.primaryEntityId, {
              tableName: "messages",
              worldId: args.worldId,
              count: args.count,
            })),
      } satisfies RelationshipsGraphServiceWithCluster)
    : null;
  if (!service) {
    return {
      service: null,
      person: null,
      degraded: [
        {
          channel: "memory",
          reason:
            "RelationshipsGraphService not registered — falling back to plain semantic search",
        },
      ],
    };
  }

  if (ref.primaryEntityId) {
    const detail = await service.getPersonDetail(ref.primaryEntityId);
    if (detail) {
      return { service, person: detail, degraded: [] };
    }
  }

  const search = ref.displayName?.trim();
  if (!search) {
    return { service, person: null, degraded: [] };
  }

  const snapshot = await service.getGraphSnapshot({ search, limit: 5 });
  const person = snapshot.people[0] ?? null;
  return { service, person, degraded: [] };
}

async function searchClusterMemories(
  runtime: IAgentRuntime,
  service: RelationshipsGraphServiceWithCluster,
  person: RelationshipsPersonSummary,
  query: CrossChannelSearchQuery,
): Promise<{
  hits: CrossChannelSearchHit[];
  degraded: CrossChannelSearchDegraded[];
}> {
  const fn = service.getMemoriesForCluster;
  if (typeof fn !== "function") {
    return {
      hits: [],
      degraded: [
        {
          channel: "memory",
          reason:
            "RelationshipsGraphService.getMemoriesForCluster is unavailable on the registered service",
        },
      ],
    };
  }

  const memories = await fn({
    primaryEntityId: person.primaryEntityId,
    count: (query.limit ?? DEFAULT_PER_CHANNEL_LIMIT) * 2,
    worldId: query.worldId,
  });
  const hits = await memoriesToHits(runtime, memories, query);
  return { hits, degraded: [] };
}

// ---------------------------------------------------------------------------
// Connector adapters that don't yet have first-class search
// ---------------------------------------------------------------------------

const CONNECTORS_WITHOUT_NATIVE_SEARCH: ReadonlyArray<{
  channel: CrossChannelSearchChannel;
  reason: string;
}> = [
  {
    channel: "calendly",
    reason: "Calendly search is not available on LifeOpsService",
  },
];

// ---------------------------------------------------------------------------
// Result merge
// ---------------------------------------------------------------------------

function dedupeHits(hits: CrossChannelSearchHit[]): CrossChannelSearchHit[] {
  const seen = new Set<string>();
  const out: CrossChannelSearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
  }
  return out;
}

function rankHits(hits: CrossChannelSearchHit[]): CrossChannelSearchHit[] {
  return [...hits].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runCrossChannelSearch(
  runtime: IAgentRuntime,
  query: CrossChannelSearchQuery,
): Promise<CrossChannelSearchResult> {
  if (query.query.trim().length === 0) {
    throw new Error("runCrossChannelSearch: query.query is required");
  }

  const channels = query.channels;
  const unsupported: CrossChannelSearchUnsupported[] = [];
  const degraded: CrossChannelSearchDegraded[] = [];
  const allHits: CrossChannelSearchHit[] = [];

  // 1. Resolve canonical person via WS3 (best-effort).
  const personResolution = await resolvePerson(runtime, query.personRef);
  degraded.push(...personResolution.degraded);

  // 2. Fan out in parallel.
  const tasks: Array<Promise<void>> = [];

  if (isChannelEnabled("gmail", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchGmail(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
          degraded.push(...r.degraded);
        } catch (err) {
          degraded.push({
            channel: "gmail",
            reason: `Gmail search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("telegram", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchTelegram(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "telegram",
            reason: `Telegram search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("discord", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchDiscord(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "discord",
            reason: `Discord search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("imessage", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchIMessages(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "imessage",
            reason: `iMessage search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("signal", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchSignal(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "signal",
            reason: `Signal search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("whatsapp", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchWhatsApp(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "whatsapp",
            reason: `WhatsApp search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("calendar", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchCalendar(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "calendar",
            reason: `Calendar search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("x", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchXPostsChannel(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "x",
            reason: `X post search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("x-dm", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchXDms(runtime, query);
          allHits.push(...r.hits);
          unsupported.push(...r.unsupported);
        } catch (err) {
          degraded.push({
            channel: "x-dm",
            reason: `X DM search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (isChannelEnabled("memory", channels)) {
    tasks.push(
      (async () => {
        try {
          const r = await searchAgentMemory(runtime, query);
          allHits.push(...r.hits);
          degraded.push(...r.degraded);
        } catch (err) {
          degraded.push({
            channel: "memory",
            reason: `Memory search failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  if (personResolution.service && personResolution.person) {
    tasks.push(
      (async () => {
        try {
          const r = await searchClusterMemories(
            runtime,
            personResolution.service as RelationshipsGraphServiceWithCluster,
            personResolution.person as RelationshipsPersonSummary,
            query,
          );
          allHits.push(...r.hits);
          degraded.push(...r.degraded);
        } catch (err) {
          degraded.push({
            channel: "memory",
            reason: `Cluster fan-out failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // 3. Emit unsupported markers for connectors without native search, only
  //    when the caller explicitly asked for that channel (so we don't spam
  //    every result with the full list).
  for (const entry of CONNECTORS_WITHOUT_NATIVE_SEARCH) {
    if (channels?.includes(entry.channel)) {
      unsupported.push(entry);
    }
  }

  // 4. Dedupe + rank.
  const merged = rankHits(dedupeHits(allHits));
  const channelsWithHits = Array.from(
    new Set(merged.map((h) => h.channel)),
  ) as CrossChannelSearchChannel[];

  const finalLimit =
    (query.limit ?? DEFAULT_PER_CHANNEL_LIMIT) *
    CROSS_CHANNEL_SEARCH_CHANNELS.length;
  const limited = merged.slice(0, finalLimit);

  logger.debug(
    `[cross-channel-search] query="${query.query}" hits=${limited.length} unsupported=${unsupported.length} degraded=${degraded.length}`,
  );

  return {
    query: query.query,
    hits: limited,
    unsupported,
    degraded,
    channelsWithHits,
    resolvedPerson: personResolution.person,
  };
}
