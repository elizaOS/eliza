import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { parsePositiveInteger } from "../utils/number-parsing.js";
import {
  getKnowledgeService,
  type KnowledgeServiceResult,
} from "./documents-service-loader.js";
import type { RouteRequestContext } from "./route-helpers.js";

const HASH_MEMORY_SOURCE = "hash_memory";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_SEARCH_SCAN_LIMIT = 500;
const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
const MEMORY_SEARCH_MAX_LIMIT = 50;
const QUICK_CONTEXT_DEFAULT_LIMIT = 8;
const QUICK_CONTEXT_MAX_LIMIT = 20;
const QUICK_CONTEXT_KNOWLEDGE_THRESHOLD = 0.2;

const MEMORY_BROWSE_DEFAULT_LIMIT = 50;
const MEMORY_BROWSE_MAX_LIMIT = 200;
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

type KnowledgeSearchHit = {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  position?: number;
};

type KnowledgeSearchMatch = {
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
    source: "client_chat",
    channelId: `${agentName}-hash-memory`,
    type: ChannelType.DM,
    messageServerId,
    metadata: { ownership: { ownerId: entityId } },
  });

  return { roomId, entityId };
}

function scoreMemoryText(text: string, query: string): number {
  const normalizedText = text.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (!normalizedText || !normalizedQuery) return 0;

  const terms = normalizedQuery
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  const containsWhole = normalizedText.includes(normalizedQuery) ? 1 : 0;
  if (terms.length === 0) {
    return containsWhole;
  }

  let termMatches = 0;
  for (const term of terms) {
    if (normalizedText.includes(term)) termMatches += 1;
  }
  return containsWhole + termMatches / terms.length;
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
  });

  const hits: MemorySearchHit[] = [];
  for (const memory of memories) {
    const text = (
      memory.content as { text?: string } | undefined
    )?.text?.trim();
    if (!text) continue;
    const source = (memory.content as { source?: string } | undefined)?.source;
    if (source !== HASH_MEMORY_SOURCE) continue;
    const score = scoreMemoryText(text, query);
    if (score <= 0) continue;
    hits.push({
      id: memory.id ?? crypto.randomUUID(),
      text,
      createdAt: memory.createdAt ?? 0,
      score,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAt - a.createdAt;
  });
  return hits.slice(0, limit);
}

async function searchKnowledge(
  runtime: AgentRuntime,
  query: string,
  limit: number,
): Promise<KnowledgeSearchHit[]> {
  const knowledge: KnowledgeServiceResult = await getKnowledgeService(runtime);
  const knowledgeService = knowledge.service;
  if (!knowledgeService || !runtime.agentId) return [];

  const agentId = runtime.agentId as UUID;
  const searchMessage: Memory = {
    id: crypto.randomUUID() as UUID,
    entityId: agentId,
    agentId,
    roomId: agentId,
    content: { text: query },
    createdAt: Date.now(),
  };

  const matches: KnowledgeSearchMatch[] = await knowledgeService.getKnowledge(
    searchMessage,
    {
      roomId: agentId,
    },
  );

  return matches
    .filter(
      (match) => (match.similarity ?? 0) >= QUICK_CONTEXT_KNOWLEDGE_THRESHOLD,
    )
    .slice(0, limit)
    .map((match) => {
      const metadata = match.metadata as Record<string, unknown> | undefined;
      return {
        id: match.id,
        text: match.content?.text ?? "",
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
  knowledge: KnowledgeSearchHit[];
}): string {
  const { query, memories, knowledge } = params;
  const memorySection =
    memories.length > 0
      ? memories
          .map((item, index) => `- [M${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";
  const knowledgeSection =
    knowledge.length > 0
      ? knowledge
          .map((item, index) => `- [K${index + 1}] ${item.text}`)
          .join("\n")
      : "- none";

  return [
    "You are a concise context assistant.",
    "Answer only from the provided context. If context is insufficient, say so explicitly.",
    "Keep the answer under 120 words.",
    "",
    `Query: ${query}`,
    "",
    "Saved memory notes:",
    memorySection,
    "",
    "Knowledge snippets:",
    knowledgeSection,
  ].join("\n");
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

function memoryToBrowseItem(memory: TaggedMemory): MemoryBrowseItem {
  const content = memory.content as Record<string, unknown> | undefined;
  return {
    id: memory.id ?? "",
    type: memory._table,
    text: (content?.text as string) ?? "",
    entityId: (memory.entityId as string) ?? null,
    roomId: (memory.roomId as string) ?? null,
    agentId: (memory.agentId as string) ?? null,
    createdAt: memory.createdAt ?? 0,
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
): Promise<TaggedMemory[]> {
  const tables = params.tables ?? MEMORY_TABLE_NAMES;
  const perTableLimit = Math.max(
    Math.ceil((params.limit ?? MEMORY_BROWSE_DEFAULT_LIMIT) * 2),
    200,
  );
  const allMemories: TaggedMemory[] = [];

  for (const tableName of tables) {
    const memories = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId: params.roomId,
      tableName,
      limit: perTableLimit,
    });
    for (const m of memories) {
      allMemories.push(Object.assign(m, { _table: tableName }));
    }
  }

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
  if (beforeTs) {
    return filtered.filter((m) => (m.createdAt ?? 0) < beforeTs);
  }
  return filtered;
}

function resolveTableFilter(
  typeParam: string | null,
): readonly string[] | undefined {
  if (!typeParam) return undefined;
  const t = typeParam.toLowerCase();
  if (MEMORY_TABLE_NAMES.includes(t as (typeof MEMORY_TABLE_NAMES)[number])) {
    return [t];
  }
  return undefined;
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
    const body = await readJsonBody<{ text?: string }>(req, res);
    if (!body) return true;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      error(res, "text is required", 400);
      return true;
    }
    const createdAt = Date.now();
    const message = createMessageMemory({
      id: crypto.randomUUID() as UUID,
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

    const [memories, knowledge] = await Promise.all([
      searchMemoryNotes(runtime, roomId, query, limit),
      searchKnowledge(runtime, query, limit),
    ]);

    const prompt = buildQuickContextPrompt({ query, memories, knowledge });
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
      knowledge,
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
    const tables = resolveTableFilter(url.searchParams.get("type"));

    const allMemories = await fetchMemoriesFromTables(runtime, {
      tables,
      limit: limit * 2,
      before,
    });

    allMemories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
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
    const tables = resolveTableFilter(url.searchParams.get("type"));
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

    const allMemories = await fetchMemoriesFromTables(runtime, {
      tables,
      entityIds,
      roomId: roomIdParam ? (roomIdParam as UUID) : undefined,
      limit: limit + offset + 100,
    });

    allMemories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    let filtered = allMemories;
    if (searchQuery) {
      filtered = allMemories.filter((m) => {
        const text = (m.content as { text?: string } | undefined)?.text ?? "";
        return scoreMemoryText(text, searchQuery) > 0;
      });
    }

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
    const primaryEntityId = decodeURIComponent(
      pathname.slice("/api/memories/by-entity/".length),
    );
    if (!primaryEntityId) {
      error(res, "Missing entity identifier.", 400);
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
    const tables = resolveTableFilter(url.searchParams.get("type"));

    const allMemories = await fetchMemoriesFromTables(runtime, {
      entityIds,
      tables,
      limit: limit + offset + 100,
    });

    allMemories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
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
    const rawId = decodeURIComponent(memoryIdMatch[1] ?? "");
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
    const body = await readJsonBody<{ text?: unknown }>(req, res);
    if (!body) return true;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      error(res, "text is required", 400);
      return true;
    }

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
      });
      counts[tableName] = memories.length;
      total += memories.length;
    }

    json(res, { total, byType: counts });
    return true;
  }

  return false;
}
