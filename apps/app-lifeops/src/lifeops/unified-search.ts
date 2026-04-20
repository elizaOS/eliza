/**
 * Unified cross-channel search (WS1).
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
 * runUnifiedSearch() to inject context for named persons/topics.
 */

import type {
  IAgentRuntime,
  Memory,
  Room,
  UUID,
} from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import type { LifeOpsGmailMessageSummary } from "@elizaos/shared/contracts/lifeops";
// WS3 dependency — types may not yet be exported from agent index when this
// file is first compiled. Importing from the source path so type-only
// resolution succeeds even before the public re-export lands.
import type {
  RelationshipsGraphService,
  RelationshipsPersonSummary,
} from "@elizaos/agent/services/relationships-graph";
import {
  getMemoriesForCluster as getClusterMemories,
  resolveRelationshipsGraphService,
} from "@elizaos/agent/services/relationships-graph";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const UNIFIED_SEARCH_CHANNELS = [
  "gmail",
  "memory",
  "telegram",
  "discord",
  "imessage",
  "whatsapp",
  "signal",
  "x-dm",
  "calendly",
  "calendar",
] as const;

export type UnifiedSearchChannel = (typeof UNIFIED_SEARCH_CHANNELS)[number];

export type UnifiedSearchTimeWindow = {
  /** ISO timestamp lower bound (inclusive). */
  startIso?: string;
  /** ISO timestamp upper bound (inclusive). */
  endIso?: string;
};

export type UnifiedSearchPersonRef = {
  /** Canonical cluster primary entity id (preferred). */
  primaryEntityId?: UUID;
  /** Free-form display name from LLM extraction (fallback). */
  displayName?: string;
};

export type UnifiedSearchQuery = {
  /** Free-form semantic query — required, no fallback default. */
  query: string;
  /** Optional named person to focus the search on. */
  personRef?: UnifiedSearchPersonRef;
  /** Optional ISO time window to bound results. */
  timeWindow?: UnifiedSearchTimeWindow;
  /** Optional explicit channel allowlist; default = all known channels. */
  channels?: UnifiedSearchChannel[];
  /** Optional worldId scope for memory search. */
  worldId?: UUID;
  /** Per-channel hit cap (default 10). */
  limit?: number;
};

export type UnifiedSearchHit = {
  channel: UnifiedSearchChannel;
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

export type UnifiedSearchUnsupported = {
  channel: UnifiedSearchChannel;
  reason: string;
};

export type UnifiedSearchDegraded = {
  channel: UnifiedSearchChannel;
  reason: string;
};

export type UnifiedSearchResult = {
  query: string;
  hits: UnifiedSearchHit[];
  unsupported: UnifiedSearchUnsupported[];
  degraded: UnifiedSearchDegraded[];
  /** Channels that produced at least one hit. */
  channelsWithHits: UnifiedSearchChannel[];
  /** Resolved canonical person, when available from WS3. */
  resolvedPerson: RelationshipsPersonSummary | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_PER_CHANNEL_LIMIT = 10;
const MEMORY_MATCH_THRESHOLD = 0.55;

const KNOWN_PLATFORM_FOR_CHANNEL: Record<UnifiedSearchChannel, string> = {
  gmail: "gmail",
  memory: "memory",
  telegram: "telegram",
  discord: "discord",
  imessage: "imessage",
  whatsapp: "whatsapp",
  signal: "signal",
  "x-dm": "x",
  calendly: "calendly",
  calendar: "calendar",
};

function withinTimeWindow(
  iso: string | undefined,
  window: UnifiedSearchTimeWindow | undefined,
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

function classifyMemoryChannel(source: string | undefined): UnifiedSearchChannel {
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
  channel: UnifiedSearchChannel,
  channels: UnifiedSearchChannel[] | undefined,
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

async function searchGmail(
  runtime: IAgentRuntime,
  query: UnifiedSearchQuery,
): Promise<{
  hits: UnifiedSearchHit[];
  unsupported: UnifiedSearchUnsupported[];
  degraded: UnifiedSearchDegraded[];
}> {
  const limit = query.limit ?? DEFAULT_PER_CHANNEL_LIMIT;
  const lifeOps = runtime.getService("lifeops") as unknown as
    | GmailSearchService
    | null;
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

  const hits: UnifiedSearchHit[] = [];
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

async function embedQuery(
  runtime: IAgentRuntime,
  text: string,
): Promise<number[] | null> {
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
  query: UnifiedSearchQuery,
): Promise<{
  hits: UnifiedSearchHit[];
  degraded: UnifiedSearchDegraded[];
}> {
  const embedding = await embedQuery(runtime, query.query);
  if (!embedding) {
    return {
      hits: [],
      degraded: [
        { channel: "memory", reason: "Embedding generation returned no vector" },
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
  query: UnifiedSearchQuery,
): Promise<UnifiedSearchHit[]> {
  const roomCache = new Map<string, Room | null>();
  const results: UnifiedSearchHit[] = [];

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
    const memId = (mem.id as string | undefined) ?? `${roomId}:${mem.createdAt}`;

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
  ref: UnifiedSearchPersonRef | undefined,
): Promise<{
  service: RelationshipsGraphServiceWithCluster | null;
  person: RelationshipsPersonSummary | null;
  degraded: UnifiedSearchDegraded[];
}> {
  if (!ref) {
    return { service: null, person: null, degraded: [] };
  }

  const baseService =
    (await resolveRelationshipsGraphService(
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
  query: UnifiedSearchQuery,
): Promise<{
  hits: UnifiedSearchHit[];
  degraded: UnifiedSearchDegraded[];
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
// Connector adapters that don't yet have first-class search
// ---------------------------------------------------------------------------

const CONNECTORS_WITHOUT_NATIVE_SEARCH: ReadonlyArray<{
  channel: UnifiedSearchChannel;
  reason: string;
}> = [
  {
    channel: "telegram",
    reason: "Telegram MTProto search not wired — covered by memory fan-out only",
  },
  {
    channel: "discord",
    reason: "Discord browser scraper does not expose search",
  },
  {
    channel: "imessage",
    reason: "iMessage bridge does not expose search",
  },
  {
    channel: "whatsapp",
    reason: "WhatsApp connector does not expose search",
  },
  {
    channel: "signal",
    reason: "Signal connector does not expose search",
  },
  {
    channel: "x-dm",
    reason: "X DM connector does not expose search",
  },
];

// ---------------------------------------------------------------------------
// Result merge
// ---------------------------------------------------------------------------

function dedupeHits(hits: UnifiedSearchHit[]): UnifiedSearchHit[] {
  const seen = new Set<string>();
  const out: UnifiedSearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
  }
  return out;
}

function rankHits(hits: UnifiedSearchHit[]): UnifiedSearchHit[] {
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

export async function runUnifiedSearch(
  runtime: IAgentRuntime,
  query: UnifiedSearchQuery,
): Promise<UnifiedSearchResult> {
  if (!query.query || query.query.trim().length === 0) {
    throw new Error("runUnifiedSearch: query.query is required");
  }

  const channels = query.channels;
  const unsupported: UnifiedSearchUnsupported[] = [];
  const degraded: UnifiedSearchDegraded[] = [];
  const allHits: UnifiedSearchHit[] = [];

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
    if (channels && channels.includes(entry.channel)) {
      unsupported.push(entry);
    }
  }

  // 4. Dedupe + rank.
  const merged = rankHits(dedupeHits(allHits));
  const channelsWithHits = Array.from(
    new Set(merged.map((h) => h.channel)),
  ) as UnifiedSearchChannel[];

  const finalLimit =
    (query.limit ?? DEFAULT_PER_CHANNEL_LIMIT) * UNIFIED_SEARCH_CHANNELS.length;
  const limited = merged.slice(0, finalLimit);

  logger.debug(
    `[unified-search] query="${query.query}" hits=${limited.length} unsupported=${unsupported.length} degraded=${degraded.length}`,
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
