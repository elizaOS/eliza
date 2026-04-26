/**
 * Cross-channel search.
 *
 * This use-case fans a single query through registered search adapters and
 * returns only cited hits from real provider, calendar, X, or memory surfaces.
 */

import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsGmailMessageSummary,
  LifeOpsXDm,
  LifeOpsXFeedItem,
} from "@elizaos/shared";
import {
  getMemoriesForCluster as getClusterMemories,
  type RelationshipsGraphService,
  type RelationshipsPersonSummary,
  resolveRelationshipsGraphService,
} from "@elizaos/agent";

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

function normalizeIso(
  value: string | number | Date | null | undefined,
): string | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

function normalizeIsoFromMs(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return null;
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
    case "tweet":
    case "x-feed":
      return "x";
    case "x_dm":
    case "x-dm":
    case "twitter-dm":
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

function queryTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

function textMatchesQuery(
  parts: Array<string | null | undefined>,
  query: string,
): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return false;
  }
  const haystack = parts
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function compactText(parts: Array<string | null | undefined>): string {
  return parts
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .map((part) => part.replace(/\s+/g, " ").trim())
    .join(" ")
    .slice(0, 600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

type TelegramSearchResult = {
  id: string | null;
  dialogId: string | null;
  dialogTitle: string | null;
  username: string | null;
  content: string;
  timestamp: string | null;
  outgoing: boolean;
};

type TelegramSearchService = {
  searchTelegramMessages: (request: {
    query: string;
    scope?: string;
    limit?: number;
  }) => Promise<TelegramSearchResult[]>;
};

type DiscordSearchResult = {
  id: string | null;
  content: string;
  authorName: string | null;
  channelId: string | null;
  timestamp: string | null;
};

type DiscordSearchService = {
  searchDiscordMessages: (request: {
    query: string;
    channelId?: string;
  }) => Promise<DiscordSearchResult[]>;
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

type IMessageSearchService = {
  searchIMessages: (request: {
    query: string;
    chatId?: string;
    limit?: number;
  }) => Promise<IMessageSearchResult[]>;
};

type CalendarSearchService = {
  getCalendarFeed: (
    requestUrl: URL,
    request?: {
      timeMin?: string;
      timeMax?: string;
    },
    now?: Date,
  ) => Promise<LifeOpsCalendarFeed>;
};

type XSearchService = {
  searchXPosts: (
    query: string,
    opts?: { limit?: number },
  ) => Promise<LifeOpsXFeedItem[]>;
  getXDms?: (opts?: {
    conversationId?: string;
    limit?: number;
  }) => Promise<LifeOpsXDm[]>;
  readXInboundDms?: (opts?: { limit?: number }) => Promise<LifeOpsXDm[]>;
};

type LifeOpsSearchService = Partial<
  GmailSearchService &
    TelegramSearchService &
    DiscordSearchService &
    IMessageSearchService &
    CalendarSearchService &
    XSearchService
>;

type SearchAdapterResult = {
  hits: CrossChannelSearchHit[];
  degraded?: CrossChannelSearchDegraded[];
};

type SearchAdapterContext = {
  runtime: IAgentRuntime;
  service: LifeOpsSearchService | null;
  query: CrossChannelSearchQuery;
  limit: number;
};

type CrossChannelSearchAdapter = {
  id: string;
  label: string;
  primaryChannel: CrossChannelSearchChannel;
  channels: readonly CrossChannelSearchChannel[];
  defaultEnabled?: boolean;
  canSearch: (context: SearchAdapterContext) => boolean;
  unavailableReason: (context: SearchAdapterContext) => string;
  search: (context: SearchAdapterContext) => Promise<SearchAdapterResult>;
};

function getLifeOpsSearchService(
  runtime: IAgentRuntime,
): LifeOpsSearchService | null {
  const service = runtime.getService("lifeops");
  return service && typeof service === "object"
    ? (service as LifeOpsSearchService)
    : null;
}

function hasSearchMethod<K extends keyof LifeOpsSearchService>(
  service: LifeOpsSearchService | null,
  key: K,
): service is LifeOpsSearchService & Required<Pick<LifeOpsSearchService, K>> {
  return Boolean(service && typeof service[key] === "function");
}

function hasMemorySearch(runtime: IAgentRuntime): boolean {
  return (
    typeof runtime.useModel === "function" &&
    typeof runtime.searchMemories === "function"
  );
}

async function searchGmail(
  service: GmailSearchService,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const requestUrl = new URL("http://127.0.0.1/api/lifeops/gmail/search");
  const feed = await service.getGmailSearch(requestUrl, {
    query: query.query,
    maxResults: limit,
  });

  const hits: CrossChannelSearchHit[] = [];
  for (const msg of feed.messages) {
    const timestamp = normalizeIso(msg.receivedAt);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    hits.push({
      channel: "gmail",
      id: `gmail:${msg.id}`,
      sourceRef: msg.id,
      timestamp,
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
  return { hits };
}

async function embedQuery(
  runtime: IAgentRuntime,
  text: string,
): Promise<number[] | null> {
  if (typeof runtime.useModel !== "function") {
    return null;
  }
  const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });
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
): Promise<SearchAdapterResult> {
  if (!hasMemorySearch(runtime)) {
    return {
      hits: [],
      degraded: [
        {
          channel: "memory",
          reason: "Agent memory search is unavailable on this runtime",
        },
      ],
    };
  }
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
  return { hits };
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
    if (!iso) {
      continue;
    }
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

async function searchTelegram(
  service: TelegramSearchService,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const rows = await service.searchTelegramMessages({
    query: query.query,
    limit,
  });
  const hits: CrossChannelSearchHit[] = [];
  for (const [index, row] of rows.entries()) {
    const timestamp = normalizeIso(row.timestamp);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    const sourceRef =
      row.id ?? row.dialogId ?? `telegram:${timestamp}:${index}`;
    hits.push({
      channel: "telegram",
      id: `telegram:${sourceRef}`,
      sourceRef,
      timestamp,
      speaker: row.outgoing
        ? "me"
        : (row.username ?? row.dialogTitle ?? "unknown"),
      text: row.content.slice(0, 600),
      citation: {
        platform: "telegram",
        label: row.dialogTitle ?? row.username ?? "Telegram search result",
      },
    });
  }
  return { hits };
}

async function searchDiscord(
  service: DiscordSearchService,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const rows = await service.searchDiscordMessages({ query: query.query });
  const hits: CrossChannelSearchHit[] = [];
  for (const [index, row] of rows.slice(0, limit).entries()) {
    const timestamp = normalizeIso(row.timestamp);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    const sourceRef =
      row.id ?? row.channelId ?? `discord:${timestamp}:${index}`;
    hits.push({
      channel: "discord",
      id: `discord:${sourceRef}`,
      sourceRef,
      timestamp,
      speaker: row.authorName ?? "unknown",
      text: row.content.slice(0, 600),
      citation: {
        platform: "discord",
        label: row.channelId
          ? `channel:${row.channelId}`
          : "Discord search result",
      },
    });
  }
  return { hits };
}

async function searchIMessages(
  service: IMessageSearchService,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const rows = await service.searchIMessages({
    query: query.query,
    limit,
  });
  const hits: CrossChannelSearchHit[] = [];
  for (const row of rows) {
    const timestamp = normalizeIso(row.sentAt);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    hits.push({
      channel: "imessage",
      id: `imessage:${row.id}`,
      sourceRef: row.id,
      timestamp,
      speaker: row.isFromMe ? "me" : row.fromHandle,
      text: row.text.slice(0, 600),
      citation: {
        platform: "imessage",
        label: row.chatId ?? row.fromHandle,
      },
    });
  }
  return { hits };
}

function calendarSpeaker(event: LifeOpsCalendarEvent): string {
  const organizer = event.organizer;
  if (organizer && typeof organizer === "object") {
    const displayName = organizer.displayName;
    if (typeof displayName === "string" && displayName.trim().length > 0) {
      return displayName.trim();
    }
    const email = organizer.email;
    if (typeof email === "string" && email.trim().length > 0) {
      return email.trim();
    }
  }
  return event.accountEmail ?? "calendar";
}

async function searchCalendar(
  service: CalendarSearchService,
  query: CrossChannelSearchQuery,
): Promise<SearchAdapterResult> {
  const requestUrl = new URL("http://127.0.0.1/api/lifeops/calendar");
  const feed = await service.getCalendarFeed(requestUrl, {
    timeMin: query.timeWindow?.startIso,
    timeMax: query.timeWindow?.endIso,
  });
  const hits: CrossChannelSearchHit[] = [];
  for (const event of feed.events) {
    const timestamp = normalizeIso(event.startAt);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    if (
      !textMatchesQuery(
        [
          event.title,
          event.description,
          event.location,
          event.calendarSummary,
          event.accountEmail,
        ],
        query.query,
      )
    ) {
      continue;
    }
    hits.push({
      channel: "calendar",
      id: `calendar:${event.id}`,
      sourceRef: event.id,
      timestamp,
      speaker: calendarSpeaker(event),
      subject: event.title,
      text: compactText([event.title, event.description, event.location]),
      citation: {
        platform: "calendar",
        label: event.title || "Calendar event",
        url: event.htmlLink ?? event.conferenceLink ?? undefined,
      },
    });
  }
  return { hits };
}

async function searchXFeed(
  service: Required<Pick<XSearchService, "searchXPosts">>,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const rows = await service.searchXPosts(query.query, { limit });
  const hits: CrossChannelSearchHit[] = [];
  for (const row of rows) {
    const timestamp = normalizeIso(row.createdAtSource);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    const handle = row.authorHandle.replace(/^@/, "");
    hits.push({
      channel: "x",
      id: `x:${row.externalTweetId}`,
      sourceRef: row.externalTweetId,
      timestamp,
      speaker: row.authorHandle,
      text: row.text.slice(0, 600),
      citation: {
        platform: "x",
        label: row.authorHandle,
        url: handle
          ? `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(
              row.externalTweetId,
            )}`
          : undefined,
      },
    });
  }
  return { hits };
}

async function searchXDms(
  service: XSearchService,
  query: CrossChannelSearchQuery,
  limit: number,
): Promise<SearchAdapterResult> {
  const searchLimit = Math.max(limit * 5, 50);
  const rows = service.getXDms
    ? await service.getXDms({ limit: searchLimit })
    : await service.readXInboundDms?.({ limit: searchLimit });
  const hits: CrossChannelSearchHit[] = [];
  for (const row of rows ?? []) {
    const timestamp = normalizeIso(row.receivedAt);
    if (!timestamp || !withinTimeWindow(timestamp, query.timeWindow)) {
      continue;
    }
    if (
      !textMatchesQuery(
        [row.text, row.senderHandle, row.senderId, row.conversationId],
        query.query,
      )
    ) {
      continue;
    }
    hits.push({
      channel: "x-dm",
      id: `x-dm:${row.externalDmId}`,
      sourceRef: row.externalDmId,
      timestamp,
      speaker: row.senderHandle,
      text: row.text.slice(0, 600),
      citation: {
        platform: "x",
        label: `DM ${row.conversationId}`,
      },
    });
    if (hits.length >= limit) {
      break;
    }
  }
  return { hits };
}

const SEARCH_PROVIDER_ADAPTERS: readonly CrossChannelSearchAdapter[] = [
  {
    id: "gmail",
    label: "Gmail",
    primaryChannel: "gmail",
    channels: ["gmail"],
    canSearch: ({ service }) => hasSearchMethod(service, "getGmailSearch"),
    unavailableReason: () =>
      "LifeOpsService.getGmailSearch is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchGmail(service as GmailSearchService, query, limit),
  },
  {
    id: "agent-memory",
    label: "Agent memory",
    primaryChannel: "memory",
    channels: CROSS_CHANNEL_SEARCH_CHANNELS,
    canSearch: ({ runtime }) => hasMemorySearch(runtime),
    unavailableReason: () =>
      "Agent memory semantic search is unavailable on this runtime",
    search: async ({ runtime, query }) => searchAgentMemory(runtime, query),
  },
  {
    id: "telegram",
    label: "Telegram",
    primaryChannel: "telegram",
    channels: ["telegram"],
    canSearch: ({ service }) =>
      hasSearchMethod(service, "searchTelegramMessages"),
    unavailableReason: () =>
      "LifeOpsService.searchTelegramMessages is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchTelegram(service as TelegramSearchService, query, limit),
  },
  {
    id: "discord",
    label: "Discord",
    primaryChannel: "discord",
    channels: ["discord"],
    canSearch: ({ service }) =>
      hasSearchMethod(service, "searchDiscordMessages"),
    unavailableReason: () =>
      "LifeOpsService.searchDiscordMessages is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchDiscord(service as DiscordSearchService, query, limit),
  },
  {
    id: "imessage",
    label: "iMessage",
    primaryChannel: "imessage",
    channels: ["imessage"],
    canSearch: ({ service }) => hasSearchMethod(service, "searchIMessages"),
    unavailableReason: () =>
      "LifeOpsService.searchIMessages is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchIMessages(service as IMessageSearchService, query, limit),
  },
  {
    id: "calendar",
    label: "Calendar",
    primaryChannel: "calendar",
    channels: ["calendar"],
    canSearch: ({ service }) => hasSearchMethod(service, "getCalendarFeed"),
    unavailableReason: () =>
      "LifeOpsService.getCalendarFeed is not registered on runtime",
    search: async ({ service, query }) =>
      searchCalendar(service as CalendarSearchService, query),
  },
  {
    id: "x-feed",
    label: "X feed",
    primaryChannel: "x",
    channels: ["x"],
    canSearch: ({ service }) => hasSearchMethod(service, "searchXPosts"),
    unavailableReason: () =>
      "LifeOpsService.searchXPosts is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchXFeed(
        service as Required<Pick<XSearchService, "searchXPosts">>,
        query,
        limit,
      ),
  },
  {
    id: "x-dm",
    label: "X DM",
    primaryChannel: "x-dm",
    channels: ["x-dm"],
    canSearch: ({ service }) =>
      hasSearchMethod(service, "getXDms") ||
      hasSearchMethod(service, "readXInboundDms"),
    unavailableReason: () =>
      "LifeOpsService.getXDms/readXInboundDms is not registered on runtime",
    search: async ({ service, query, limit }) =>
      searchXDms(service as XSearchService, query, limit),
  },
];

function adapterCoversChannel(
  adapter: CrossChannelSearchAdapter,
  channel: CrossChannelSearchChannel,
): boolean {
  return adapter.channels.includes(channel);
}

function adapterEnabledForQuery(
  adapter: CrossChannelSearchAdapter,
  channels: CrossChannelSearchChannel[] | undefined,
): boolean {
  if (!channels || channels.length === 0) {
    return adapter.defaultEnabled !== false;
  }
  return channels.some((channel) => adapterCoversChannel(adapter, channel));
}

function unsupportedForExplicitChannels(
  context: SearchAdapterContext,
  runnableAdapters: readonly CrossChannelSearchAdapter[],
): CrossChannelSearchUnsupported[] {
  const channels = context.query.channels;
  if (!channels || channels.length === 0) {
    return [];
  }

  const unsupported: CrossChannelSearchUnsupported[] = [];
  for (const channel of new Set(channels)) {
    if (
      runnableAdapters.some((adapter) => adapterCoversChannel(adapter, channel))
    ) {
      continue;
    }
    const adapter =
      SEARCH_PROVIDER_ADAPTERS.find(
        (candidate) => candidate.primaryChannel === channel,
      ) ??
      SEARCH_PROVIDER_ADAPTERS.find((candidate) =>
        adapterCoversChannel(candidate, channel),
      );
    unsupported.push({
      channel,
      reason:
        adapter?.unavailableReason(context) ??
        `No search adapter is registered for channel ${channel}`,
    });
  }
  return unsupported;
}

// ---------------------------------------------------------------------------
// WS3 cluster fan-out
// ---------------------------------------------------------------------------

// Relationships service builds may not expose cluster fan-out yet, so keep the
// optional signature local to this use-case.
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
            "RelationshipsGraphService.getMemoriesForCluster not implemented yet",
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
  if (!query.query || query.query.trim().length === 0) {
    throw new Error("runCrossChannelSearch: query.query is required");
  }

  const channels = query.channels;
  const degraded: CrossChannelSearchDegraded[] = [];
  const allHits: CrossChannelSearchHit[] = [];
  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const service = getLifeOpsSearchService(runtime);
  const context: SearchAdapterContext = {
    runtime,
    service,
    query,
    limit,
  };
  const runnableAdapters = SEARCH_PROVIDER_ADAPTERS.filter(
    (adapter) =>
      adapterEnabledForQuery(adapter, channels) && adapter.canSearch(context),
  );
  const unsupported = unsupportedForExplicitChannels(context, runnableAdapters);

  // 1. Resolve canonical person via WS3 (best-effort).
  const personResolution = await resolvePerson(runtime, query.personRef);
  degraded.push(...personResolution.degraded);

  // 2. Fan out in parallel.
  const tasks: Array<Promise<void>> = [];

  for (const adapter of runnableAdapters) {
    tasks.push(
      (async () => {
        try {
          const r = await adapter.search(context);
          allHits.push(...r.hits);
          degraded.push(...(r.degraded ?? []));
        } catch (err) {
          degraded.push({
            channel: adapter.primaryChannel,
            reason: `${adapter.label} search failed: ${errorMessage(err)}`,
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
            reason: `Cluster fan-out failed: ${errorMessage(err)}`,
          });
        }
      })(),
    );
  }

  await Promise.all(tasks);

  // 3. Dedupe + rank.
  const merged = rankHits(dedupeHits(allHits));

  const finalLimit = limit * CROSS_CHANNEL_SEARCH_CHANNELS.length;
  const limited = merged.slice(0, finalLimit);
  const channelsWithHits = Array.from(
    new Set(limited.map((h) => h.channel)),
  ) as CrossChannelSearchChannel[];

  logger.debug(
    {
      query: query.query,
      hits: limited.length,
      unsupported: unsupported.length,
      degraded: degraded.length,
    },
    "[CrossChannelSearch] search completed",
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
