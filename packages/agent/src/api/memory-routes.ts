/**
 * Memory + knowledge HTTP endpoints for the agent's dashboard/control API,
 * mounted behind that API's auth layer (returns 503 when no runtime is
 * attached).
 *
 * Hash-memory notes: POST /api/memory/remember stores a note, GET
 * /api/memory/search BM25-ranks them. GET /api/context/quick answers a query
 * over both hash-memory notes and documents via a TEXT_SMALL model call.
 * Memory viewer: GET /api/memories/feed | /browse | /by-entity/:id | /stats
 * read across the messages/memories/facts/documents tables; DELETE and PATCH
 * /api/memories/:id delete or edit-and-re-embed a single row (the id must look
 * like a UUID, keeping the literal sibling routes unambiguous).
 */
import crypto from "node:crypto";
import {
  type AgentRuntime,
  BM25,
  ChannelType,
  composePrompt,
  createMessageMemory,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  ModelType,
  memoryContextQaTemplate,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { RouteRequestContext } from "@elizaos/shared";
import {
  PatchMemoryRequestSchema,
  PostMemoryRememberRequestSchema,
  parsePositiveInteger,
} from "@elizaos/shared";
import {
  type DocumentsServiceResult,
  getDocumentsService,
} from "./documents-service-loader.ts";
import { decodePathComponent } from "./server-helpers.ts";

export const HASH_MEMORY_SOURCE = "hash_memory";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_SEARCH_SCAN_LIMIT = 2_000;
const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
const MEMORY_SEARCH_MAX_LIMIT = 50;
const QUICK_CONTEXT_DEFAULT_LIMIT = 8;
const QUICK_CONTEXT_MAX_LIMIT = 20;
const QUICK_CONTEXT_DOCUMENTS_THRESHOLD = 0.2;

const MEMORY_BROWSE_DEFAULT_LIMIT = 50;
const MEMORY_BROWSE_MAX_LIMIT = 200;
/**
 * Hard per-table safety cap for the filtered-browse drain loop. The drain
 * doubles its fetch window until the requested page (plus one sentinel row)
 * is satisfied or the adapter is exhausted; this cap bounds the worst-case
 * scan to 10k rows per table so a needle-in-a-haystack filter cannot turn a
 * page request into an unbounded table scan.
 */
const MEMORY_BROWSE_SCAN_CAP = 10_000;
const MEMORY_FEED_DEFAULT_LIMIT = 50;
const MEMORY_FEED_MAX_LIMIT = 100;
const MEMORY_TABLE_NAMES = [
  "messages",
  "memories",
  "facts",
  "documents",
] as const;

export interface MemoryRouteContext extends RouteRequestContext {
  url: URL;
  runtime: AgentRuntime | null;
  agentName: string;
}

type MemorySearchHit = {
  id: string;
  text: string;
  createdAt: number;
  score: number;
};

type DocumentSearchHit = {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  position?: number;
};

type DocumentSearchMatch = {
  id: UUID;
  content: { text?: string };
  similarity?: number;
  metadata?: Record<string, unknown>;
};

function resolveAgentName(runtime: AgentRuntime, fallbackName: string): string {
  return runtime.character.name?.trim() || fallbackName || "Eliza";
}

async function ensureMemoryConnection(
  runtime: AgentRuntime,
  agentName: string,
): Promise<{ roomId: UUID; entityId: UUID }> {
  const entityId = runtime.agentId as UUID;
  const roomId = stringToUuid(`${agentName}-hash-memory-room`) as UUID;
  const worldId = stringToUuid(`${agentName}-hash-memory-world`) as UUID;
  const messageServerId = stringToUuid(
    `${agentName}-hash-memory-server`,
  ) as UUID;

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: "User",
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    channelId: `${agentName}-hash-memory`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: entityId } },
  });

  return { roomId, entityId };
}

/**
 * Rank a candidate set against `query` with Okapi BM25 + Porter2 stemming,
 * returning each item with a [0,1] max-normalized relevance score in input order.
 *
 * Corpus-aware IDF down-weights filler/stop words and TF saturation + length
 * normalization rank genuinely-relevant text first; a naive pairwise substring
 * count with no IDF would let a doc that merely contains a common query word
 * ("the") tie with a real hit. We use the `search.ts` BM25
 * (not the documents `bm25Scores`) specifically for its **Porter2 stemming** —
 * short typed chat queries are usually base forms ("configure") while stored
 * messages carry inflected forms ("configuring"/"configured"/"configuration"),
 * and stemming is the standard keyword answer to that mismatch. It also brings
 * stop-word removal and proper Unicode/accent/CJK normalization (the documents
 * tokenizer strips non-ASCII, silently dropping accented + non-Latin text).
 */
export function rankByKeyword<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): Array<{ item: T; score: number }> {
  if (items.length === 0) return [];
  // Single `content` field per doc so only the text is indexed; items are
  // tracked by array index (the BM25 result `index`).
  const bm25 = new BM25(
    items.map((item) => ({ content: getText(item) })),
    { stemming: true },
  );
  const results = bm25.search(query, items.length);
  if (results.length === 0) return items.map((item) => ({ item, score: 0 }));
  const firstScore = results[0]?.score;
  const maxScore = typeof firstScore === "number" ? firstScore : 0;
  const scoreByIndex = new Map(results.map((r) => [r.index, r.score]));
  return items.map((item, i) => {
    const indexedScore = scoreByIndex.get(i);
    return {
      item,
      score:
        maxScore > 0
          ? (typeof indexedScore === "number" ? indexedScore : 0) / maxScore
          : 0,
    };
  });
}

/**
 * Boolean keyword match for *filtering* (not ranking): does the text contain the
 * whole query or any query term (≥2 chars)? Used where the caller wants
 * "messages matching this text", not a relevance ranking.
 */
export function matchesKeyword(text: string, query: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedText || !normalizedQuery) return false;
  if (normalizedText.includes(normalizedQuery)) return true;
  return normalizedQuery
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .some((term) => normalizedText.includes(term));
}

async function searchMemoryNotes(
  runtime: AgentRuntime,
  roomId: UUID,
  query: string,
  limit: number,
): Promise<MemorySearchHit[]> {
  const memories = await runtime.getMemories({
    roomId,
    tableName: "messages",
    limit: MEMORY_SEARCH_SCAN_LIMIT,
    includeEmbedding: false, // only reads content.text
  });

  // Gather hash-memory candidates first, then BM25-rank them as a corpus.
  const candidates: Array<{ id: UUID; text: string; createdAt: number }> = [];
  for (const memory of memories) {
    const text = (
      memory.content as { text?: string } | undefined
    )?.text?.trim();
    if (!text) continue;
    const source = (memory.content as { source?: string } | undefined)?.source;
    if (source !== HASH_MEMORY_SOURCE) continue;
    if (!memory.id || typeof memory.createdAt !== "number") continue;
    candidates.push({
      id: memory.id,
      text,
      createdAt: memory.createdAt,
    });
  }

  const hits: MemorySearchHit[] = rankByKeyword(
    query,
    candidates,
    (c) => c.text,
  )
    .filter(({ score }) => score > 0)
    .map(({ item, score }) => ({
      id: item.id,
      text: item.text,
      createdAt: item.createdAt,
      score,
    }));

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAt - a.createdAt;
  });
  return hits.slice(0, limit);
}

async function searchDocuments(
  runtime: AgentRuntime,
  query: string,
  limit: number,
): Promise<DocumentSearchHit[]> {
  const documents: DocumentsServiceResult = await getDocumentsService(runtime);
  const documentsService = documents.service;
  if (!documentsService || !runtime.agentId) return [];

  const agentId = runtime.agentId as UUID;
  const searchMessage: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: agentId,
    agentId,
    roomId: agentId,
    content: { text: query },
    createdAt: Date.now(),
  };

  const matches: DocumentSearchMatch[] = await documentsService.searchDocuments(
    searchMessage,
    {
      roomId: agentId,
    },
  );

  return matches
    .filter(
      (match) => (match.similarity ?? 0) >= QUICK_CONTEXT_DOCUMENTS_THRESHOLD,
    )
    .slice(0, limit)
    .map((match) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      return {
        id: match.id,
        text: match.content.text ?? "",
        similarity: match.similarity ?? 0,
        documentId:
          typeof metadata?.documentId === "string"
            ? metadata.documentId
            : undefined,
        documentTitle:
          typeof metadata?.filename === "string"
            ? metadata.filename
            : typeof metadata?.title === "string"
              ? metadata.title
              : undefined,
        position:
          typeof metadata?.position === "number"
            ? metadata.position
            : undefined,
      };
    });
}

function buildQuickContextPrompt(params: {
  query: string;
  memories: MemorySearchHit[];
  documents: DocumentSearchHit[];
}): string {
  const { query, memories, documents } = params;
  const memorySection =
    memories.length > 0
      ? memories
          .map((item, index) => `- [M${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";
  const documentsSection =
    documents.length > 0
      ? documents
          .map((item, index) => `- [D${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";

  return composePrompt({
    state: { query, memorySection, knowledgeSection: documentsSection },
    template: memoryContextQaTemplate,
  });
}

type MemoryBrowseItem = {
  id: string;
  type: string;
  text: string;
  entityId: string | null;
  roomId: string | null;
  agentId: string | null;
  createdAt: number;
  metadata: Record<string, unknown> | null;
  source: string | null;
};

type TaggedMemory = Memory & { _table: string };

/** Ordering key — `Memory.createdAt` is optional; rows without one sort as oldest. */
const memoryCreatedAt = (memory: { createdAt?: number }): number =>
  memory.createdAt ?? 0;

/** Newest-first comparator shared by the browse/search/feed list routes. */
const byNewestFirst = (
  a: { createdAt?: number },
  b: { createdAt?: number },
): number => memoryCreatedAt(b) - memoryCreatedAt(a);

function memoryToBrowseItem(memory: TaggedMemory): MemoryBrowseItem {
  const content = memory.content as Record<string, unknown> | undefined;
  return {
    id: memory.id ?? "",
    type: memory._table,
    text: (content?.text as string) ?? "",
    entityId: memory.entityId,
    roomId: memory.roomId,
    agentId: memory.agentId ?? null,
    createdAt: memoryCreatedAt(memory),
    metadata: (memory.metadata as Record<string, unknown>) ?? null,
    source: (content?.source as string) ?? null,
  };
}

function hasBrowsableContent(memory: TaggedMemory): boolean {
  const text = (memory.content as { text?: string } | undefined)?.text;
  return typeof text === "string" && text.trim().length > 0;
}

async function fetchMemoriesFromTables(
  runtime: AgentRuntime,
  params: {
    entityIds?: UUID[];
    roomId?: UUID;
    tables?: readonly string[];
    limit?: number;
    before?: number;
  },
): Promise<{
  memories: TaggedMemory[];
  /** Every table returned fewer rows than requested — nothing deeper exists. */
  exhausted: boolean;
  /** The per-table fetch window hit MEMORY_BROWSE_SCAN_CAP. */
  capped: boolean;
}> {
  const tables = params.tables ?? MEMORY_TABLE_NAMES;
  const perTableLimit = Math.min(
    Math.max(Math.ceil((params.limit ?? MEMORY_BROWSE_DEFAULT_LIMIT) * 2), 200),
    MEMORY_BROWSE_SCAN_CAP,
  );
  // Read every table concurrently — they are independent queries, and a
  // sequential loop would make the feed's first paint wait on N round-trips.
  // Promise.all preserves input order, so the flattened result is order-stable.
  const perTableMemories = await Promise.all(
    tables.map(async (tableName) => {
      const memories = await runtime.getMemories({
        agentId: runtime.agentId as UUID,
        roomId: params.roomId,
        tableName,
        limit: perTableLimit,
        includeEmbedding: false, // browse feed discards embeddings (memoryToBrowseItem)
      });
      return memories.map((m) => Object.assign(m, { _table: tableName }));
    }),
  );
  const allMemories: TaggedMemory[] = perTableMemories.flat();
  const exhausted = perTableMemories.every(
    (rows) => rows.length < perTableLimit,
  );
  const capped = perTableLimit >= MEMORY_BROWSE_SCAN_CAP;

  // The DB adapter ignores entityId in getMemories (used only for RLS
  // context). Post-filter here so person-centric views actually work.
  const entitySet = params.entityIds;
  let filtered = allMemories;
  if (entitySet && entitySet.length > 0) {
    const ids = new Set<string>(entitySet);
    filtered = allMemories.filter((m) => m.entityId && ids.has(m.entityId));
  }

  filtered = filtered.filter(hasBrowsableContent);

  const beforeTs = params.before;
  if (beforeTs !== undefined) {
    filtered = filtered.filter((m) => memoryCreatedAt(m) < beforeTs);
  }
  return { memories: filtered, exhausted, capped };
}

/**
 * Drain loop for filtered browse paths. Every filter here (entityId, empty
 * text, `before`, keyword `q`) is applied *after* the adapter's `limit`, so a
 * single fixed over-fetch window loses matches: a selective filter can leave
 * the page short while thousands of deeper matching rows exist. Refetch with a
 * doubling window until the caller's target (page end plus one sentinel row)
 * is met, the adapter is truly exhausted (returned fewer rows than requested),
 * or the MEMORY_BROWSE_SCAN_CAP safety cap is hit.
 *
 * Totals contract for callers: when `exhausted` is true the filtered array is
 * the complete match set, so its length is an exact total. When the cap
 * stopped the drain instead, the length is a lower bound — but it is then
 * guaranteed to be >= the caller's target, so `total > offset + limit` and
 * pagination controls stay enabled rather than falsely reporting exhaustion.
 */
async function drainFilteredMemories(
  runtime: AgentRuntime,
  params: {
    entityIds?: UUID[];
    roomId?: UUID;
    tables?: readonly string[];
    before?: number;
  },
  target: number,
  keywordQuery?: string,
): Promise<{ filtered: TaggedMemory[]; exhausted: boolean }> {
  let requestLimit = Math.max(target + 100, MEMORY_BROWSE_DEFAULT_LIMIT);
  for (;;) {
    const { memories, exhausted, capped } = await fetchMemoriesFromTables(
      runtime,
      { ...params, limit: requestLimit },
    );
    const filtered = keywordQuery
      ? memories.filter((m) => {
          const text = (m.content as { text?: string } | undefined)?.text ?? "";
          return matchesKeyword(text, keywordQuery);
        })
      : memories;
    if (filtered.length >= target || exhausted || capped) {
      return { filtered, exhausted };
    }
    requestLimit *= 2;
  }
}

/**
 * Parse the memory-viewer `type` query. Omitted/empty means every table
 * (the "all" tab). A known table name narrows the scan. Any other token
 * used to fall through to that same unfiltered scan, so `type=notes` or
 * `type=message` silently returned the whole feed.
 */
export function parseMemoryTableFilter(
  typeParam: string | null,
): { ok: true; tables?: readonly string[] } | { ok: false; message: string } {
  if (typeParam === null || typeParam === "") return { ok: true };
  const t = typeParam.toLowerCase();
  if (MEMORY_TABLE_NAMES.includes(t as (typeof MEMORY_TABLE_NAMES)[number])) {
    return { ok: true, tables: [t] };
  }
  return {
    ok: false,
    message: `type must be one of: ${MEMORY_TABLE_NAMES.join(", ")}`,
  };
}

export async function handleMemoryRoutes(
  ctx: MemoryRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    runtime,
    agentName,
    json,
    error,
    readJsonBody,
  } = ctx;

  if (
    !pathname.startsWith("/api/memory") &&
    !pathname.startsWith("/api/memories") &&
    pathname !== "/api/context/quick"
  ) {
    return false;
  }

  if (!runtime) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }

  const resolvedAgentName = resolveAgentName(runtime, agentName);
  const { roomId, entityId } = await ensureMemoryConnection(
    runtime,
    resolvedAgentName,
  );

  if (method === "POST" && pathname === "/api/memory/remember") {
    const rawRem = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawRem === null) return true;
    const parsedRem = PostMemoryRememberRequestSchema.safeParse(rawRem);
    if (!parsedRem.success) {
      error(res, parsedRem.error.issues[0]?.message ?? "text is required", 400);
      return true;
    }
    const text = parsedRem.data.text;
    const createdAt = Date.now();
    const memoryId = parsedRem.data.idempotencyKey
      ? (stringToUuid(
          `${HASH_MEMORY_SOURCE}:${runtime.agentId}:${parsedRem.data.idempotencyKey}`,
        ) as UUID)
      : (crypto.randomUUID() as UUID);
    const existing = parsedRem.data.idempotencyKey
      ? await runtime.getMemoryById(memoryId)
      : null;
    if (existing) {
      json(res, {
        ok: true,
        id: existing.id,
        text: existing.content.text ?? text,
        createdAt: existing.createdAt,
        replayed: true,
      });
      return true;
    }
    const message = createMessageMemory({
      id: memoryId,
      entityId,
      roomId,
      content: {
        text,
        source: HASH_MEMORY_SOURCE,
        channelType: ChannelType.DM,
      },
    });
    await runtime.createMemory(message, "messages");
    json(res, {
      ok: true,
      id: message.id,
      text,
      createdAt,
      replayed: false,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/memory/search") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (!query) {
      error(res, "Search query (q) is required", 400);
      return true;
    }
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_SEARCH_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_SEARCH_MAX_LIMIT,
    );
    const results = await searchMemoryNotes(runtime, roomId, query, limit);
    json(res, {
      query,
      results,
      count: results.length,
      limit,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/context/quick") {
    const query = url.searchParams.get("q")?.trim() ?? "";
    if (!query) {
      error(res, "Search query (q) is required", 400);
      return true;
    }
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      QUICK_CONTEXT_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      QUICK_CONTEXT_MAX_LIMIT,
    );

    const [memories, documents] = await Promise.all([
      searchMemoryNotes(runtime, roomId, query, limit),
      searchDocuments(runtime, query, limit),
    ]);

    const prompt = buildQuickContextPrompt({ query, memories, documents });
    let answer = "I couldn't generate a quick answer right now.";
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const text = typeof response === "string" ? response : String(response);
    if (text.trim()) {
      answer = text.trim();
    }

    json(res, {
      query,
      answer,
      memories,
      documents,
    });
    return true;
  }

  // ── Memory Viewer endpoints ───────────────────────────────────────────

  if (method === "GET" && pathname === "/api/memories/feed") {
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_FEED_DEFAULT_LIMIT,
    );
    const limit = Math.min(Math.max(requestedLimit, 1), MEMORY_FEED_MAX_LIMIT);
    const beforeParam = url.searchParams.get("before");
    const before = beforeParam ? Number(beforeParam) : undefined;
    // Number("abc") is NaN, which is a `number` and so survives the
    // `beforeTs !== undefined` cursor gate below — but every `< NaN`
    // comparison is false, so a malformed cursor would silently empty the
    // feed with a 200. Reject it here instead, mirroring the `type` guard.
    if (before !== undefined && !Number.isFinite(before)) {
      error(res, "before must be a finite Unix timestamp in milliseconds", 400);
      return true;
    }
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;

    // Drain until limit+1 browsable rows exist (the extra row is a sentinel
    // proving there is a next page) or the tables are exhausted, so hasMore
    // cannot false-negative just because empty-text rows padded the window.
    const { filtered: allMemories } = await drainFilteredMemories(
      runtime,
      { tables, before },
      limit + 1,
    );

    allMemories.sort(byNewestFirst);
    const items = allMemories.slice(0, limit).map(memoryToBrowseItem);

    json(res, {
      memories: items,
      count: items.length,
      limit,
      hasMore: allMemories.length > limit,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/memories/browse") {
    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_BROWSE_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_BROWSE_MAX_LIMIT,
    );
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;
    const entityIdParam = url.searchParams.get("entityId");
    const entityIdsParam = url.searchParams.get("entityIds");
    const roomIdParam = url.searchParams.get("roomId");
    const searchQuery = url.searchParams.get("q")?.trim() ?? "";

    const entityIds: UUID[] | undefined = entityIdsParam
      ? (entityIdsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean) as UUID[])
      : entityIdParam
        ? [entityIdParam as UUID]
        : undefined;

    const { filtered } = await drainFilteredMemories(
      runtime,
      {
        tables,
        entityIds,
        roomId: roomIdParam ? (roomIdParam as UUID) : undefined,
      },
      offset + limit + 1,
      searchQuery || undefined,
    );

    filtered.sort(byNewestFirst);

    // Exact when the drain exhausted the tables; otherwise a lower bound that
    // exceeds offset+limit, so paging controls never falsely disable (see
    // drainFilteredMemories).
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit).map(memoryToBrowseItem);

    json(res, {
      memories: page,
      total,
      limit,
      offset,
    });
    return true;
  }

  if (method === "GET" && pathname.startsWith("/api/memories/by-entity/")) {
    const primaryEntityId = decodePathComponent(
      pathname.slice("/api/memories/by-entity/".length),
      res,
      "entity identifier",
    );
    if (primaryEntityId === null) return true;
    if (!UUID_REGEX.test(primaryEntityId)) {
      error(res, "Invalid entity identifier.", 400);
      return true;
    }

    // Support multi-identity people: ?entityIds=id1,id2,id3
    // Falls back to the single path param if not provided.
    const entityIdsParam = url.searchParams.get("entityIds");
    const entityIds: UUID[] = entityIdsParam
      ? (entityIdsParam
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean) as UUID[])
      : [primaryEntityId as UUID];

    const requestedLimit = parsePositiveInteger(
      url.searchParams.get("limit"),
      MEMORY_BROWSE_DEFAULT_LIMIT,
    );
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      MEMORY_BROWSE_MAX_LIMIT,
    );
    const offset = parsePositiveInteger(url.searchParams.get("offset"), 0);
    const tableFilter = parseMemoryTableFilter(url.searchParams.get("type"));
    if (!tableFilter.ok) {
      error(res, tableFilter.message, 400);
      return true;
    }
    const tables = tableFilter.tables;

    // The adapter ignores entityId, so the entity filter is post-limit and can
    // be extremely selective — drain until the page is satisfied (see
    // drainFilteredMemories for the total semantics).
    const { filtered: allMemories } = await drainFilteredMemories(
      runtime,
      { entityIds, tables },
      offset + limit + 1,
    );

    allMemories.sort(byNewestFirst);
    const total = allMemories.length;
    const page = allMemories
      .slice(offset, offset + limit)
      .map(memoryToBrowseItem);

    json(res, {
      entityId: primaryEntityId,
      memories: page,
      total,
      limit,
      offset,
    });
    return true;
  }

  // ── Memory mutation by id ─────────────────────────────────────────────
  // DELETE /api/memories/:id and PATCH /api/memories/:id operate on the bare
  // id segment. Path matching only fires when the segment looks like a UUID,
  // which keeps the literal sibling routes (`feed`, `browse`, `stats`,
  // `by-entity/...`) unambiguous.

  const memoryIdMatch = /^\/api\/memories\/([^/]+)$/.exec(pathname);
  if (memoryIdMatch && (method === "DELETE" || method === "PATCH")) {
    const rawId = decodePathComponent(memoryIdMatch[1] ?? "", res, "memory id");
    if (rawId === null) return true;
    if (!UUID_REGEX.test(rawId)) {
      error(res, "Invalid memory id.", 400);
      return true;
    }
    const memoryId = rawId as UUID;
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      error(res, "Memory not found.", 404);
      return true;
    }

    if (method === "DELETE") {
      await runtime.deleteMemory(memoryId);
      json(res, { deleted: true, id: memoryId });
      return true;
    }

    // PATCH — update text, regenerate embedding, then atomically persist
    // both via runtime.updateMemory (the SQL adapter writes content +
    // embedding in a single transaction). If embedding generation fails we
    // return 500 *before* touching the database, so there is nothing to roll
    // back.
    const rawPat = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawPat === null) return true;
    const parsedPat = PatchMemoryRequestSchema.safeParse(rawPat);
    if (!parsedPat.success) {
      error(res, parsedPat.error.issues[0]?.message ?? "text is required", 400);
      return true;
    }
    const text = parsedPat.data.text;

    const existingContent =
      (existing.content as Record<string, unknown> | undefined) ?? {};
    const nextContent = { ...existingContent, text };

    let embedding: number[];
    try {
      embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      error(res, `Failed to regenerate embedding: ${detail}`, 500);
      return true;
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      error(res, "Embedding model returned no vector.", 500);
      return true;
    }

    await runtime.updateMemory({
      id: memoryId,
      content: nextContent,
      embedding,
    });

    const updated = await runtime.getMemoryById(memoryId);
    json(res, { updated: true, id: memoryId, memory: updated });
    return true;
  }

  if (method === "GET" && pathname === "/api/memories/stats") {
    const counts: Record<string, number> = {};
    let total = 0;

    for (const tableName of MEMORY_TABLE_NAMES) {
      const memories = await runtime.getMemories({
        agentId: runtime.agentId as UUID,
        tableName,
        limit: 10000,
        includeEmbedding: false, // stats only counts memories.length
      });
      counts[tableName] = memories.length;
      total += memories.length;
    }

    json(res, { total, byType: counts });
    return true;
  }

  return false;
}
