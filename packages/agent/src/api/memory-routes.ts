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
import { parsePositiveInteger } from "../utils/number-parsing";
import { getKnowledgeService } from "./knowledge-service-loader";
import type { RouteRequestContext } from "./route-helpers";

const HASH_MEMORY_SOURCE = "hash_memory";
const MEMORY_SEARCH_SCAN_LIMIT = 500;
const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
const MEMORY_SEARCH_MAX_LIMIT = 50;
const QUICK_CONTEXT_DEFAULT_LIMIT = 8;
const QUICK_CONTEXT_MAX_LIMIT = 20;
const QUICK_CONTEXT_KNOWLEDGE_THRESHOLD = 0.2;

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
    count: MEMORY_SEARCH_SCAN_LIMIT,
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
  const knowledge = await getKnowledgeService(runtime);
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

  const matches = await knowledgeService.getKnowledge(searchMessage, {
    roomId: agentId,
  });

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
    try {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
      const text = typeof response === "string" ? response : String(response);
      if (text.trim()) {
        answer = text.trim();
      }
    } catch {
      // Keep fallback answer.
    }

    json(res, {
      query,
      answer,
      memories,
      knowledge,
    });
    return true;
  }

  return false;
}
