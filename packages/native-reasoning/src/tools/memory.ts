/**
 * `recall` and `remember` tools — bridge the model into eliza's memory layer.
 *
 *   - recall    queries persistent memory by semantic similarity (with a
 *               BM25 rerank when query text is provided).
 *   - remember  saves a fact via runtime.createMemory (which performs secret
 *               redaction before persisting).
 *
 * The runtime API differs slightly across versions, so we feature-detect:
 *   - prefer `runtime.messageManager.searchMemoriesByEmbedding` when present
 *     (older eliza branches expose a MessageManager wrapper).
 *   - else use `runtime.searchMemories` (current `IAgentRuntime`).
 *   - else fall back to `runtime.databaseAdapter.searchMemories` /
 *     `runtime.adapter.searchMemories`.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { NativeTool, NativeToolHandler } from "../tool-schema.js";

const RECALL_DEFAULT_LIMIT = 5;
const RECALL_MAX_LIMIT = 20;

/* ──────────────────────────────────────────────────────────────────── *
 *  recall                                                               *
 * ──────────────────────────────────────────────────────────────────── */

export interface RecallInput {
  query: string;
  limit?: number;
}

export const recallTool: NativeTool = {
  type: "custom",
  name: "recall",
  description:
    "Query the agent's persistent memory by semantic similarity. Returns " +
    "the top-N most relevant memory snippets.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: {
        type: "number",
        description: "Max results to return (1–20, default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

interface SearchableRuntime {
  agentId?: UUID;
  useModel?: (modelType: string, params: unknown) => Promise<unknown>;
  searchMemories?: (params: {
    embedding: number[];
    query?: string;
    limit?: number;
    tableName: string;
    roomId?: UUID;
  }) => Promise<Memory[]>;
  messageManager?: {
    searchMemoriesByEmbedding?: (
      embedding: number[],
      opts: { count?: number; roomId?: UUID; match_threshold?: number },
    ) => Promise<Memory[]>;
  };
  databaseAdapter?: {
    searchMemories?: (params: {
      embedding: number[];
      tableName: string;
      limit?: number;
      roomId?: UUID;
    }) => Promise<Memory[]>;
  };
  adapter?: {
    searchMemories?: (params: {
      embedding: number[];
      tableName: string;
      limit?: number;
      roomId?: UUID;
    }) => Promise<Memory[]>;
  };
}

async function getEmbedding(
  rt: SearchableRuntime,
  text: string,
): Promise<number[] | null> {
  if (typeof rt.useModel !== "function") return null;
  try {
    const out = await rt.useModel("TEXT_EMBEDDING", { text });
    if (Array.isArray(out) && out.every((n) => typeof n === "number")) {
      return out as number[];
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const recallHandler: NativeToolHandler = async (
  rawInput,
  runtime: IAgentRuntime,
  message: Memory,
) => {
  const input = (rawInput ?? {}) as Partial<RecallInput>;
  if (typeof input.query !== "string" || input.query.length === 0) {
    return { content: "recall: 'query' is required", is_error: true };
  }
  const limit = Math.max(
    1,
    Math.min(RECALL_MAX_LIMIT, input.limit ?? RECALL_DEFAULT_LIMIT),
  );

  const rt = runtime as unknown as SearchableRuntime;
  const roomId = message?.roomId;

  const embedding = await getEmbedding(rt, input.query);
  if (!embedding) {
    return {
      content: "recall: no embedding model available; cannot search memory.",
      is_error: true,
    };
  }

  let memories: Memory[] = [];
  try {
    if (rt.messageManager?.searchMemoriesByEmbedding) {
      memories = await rt.messageManager.searchMemoriesByEmbedding(embedding, {
        count: limit,
        roomId,
      });
    } else if (rt.searchMemories) {
      memories = await rt.searchMemories({
        embedding,
        query: input.query,
        limit,
        tableName: "messages",
        roomId,
      });
    } else if (rt.databaseAdapter?.searchMemories) {
      memories = await rt.databaseAdapter.searchMemories({
        embedding,
        limit,
        tableName: "messages",
        roomId,
      });
    } else if (rt.adapter?.searchMemories) {
      memories = await rt.adapter.searchMemories({
        embedding,
        limit,
        tableName: "messages",
        roomId,
      });
    } else {
      return {
        content: "recall: runtime exposes no memory search API.",
        is_error: true,
      };
    }
  } catch (err) {
    return {
      content: `recall: search failed: ${(err as Error).message}`,
      is_error: true,
    };
  }

  if (memories.length === 0) return { content: "(no matching memories)" };

  const lines = memories.map((m, i) => {
    const text = (m.content?.text ?? "").trim().replace(/\s+/g, " ");
    const ts = m.createdAt ? new Date(m.createdAt).toISOString() : "?";
    return `${i + 1}. [${ts}] ${text.slice(0, 400)}`;
  });
  return { content: lines.join("\n") };
};

/* ──────────────────────────────────────────────────────────────────── *
 *  remember                                                             *
 * ──────────────────────────────────────────────────────────────────── */

export interface RememberInput {
  text: string;
  category?: string;
}

export const rememberTool: NativeTool = {
  type: "custom",
  name: "remember",
  description:
    "Persist a fact to the agent's long-term memory. Accepts an optional " +
    "category tag (e.g., 'preference', 'fact', 'todo').",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The thing to remember." },
      category: {
        type: "string",
        description: "Optional category / tag for later filtering.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

interface MemoryWritableRuntime {
  agentId?: UUID;
  createMemory?: (
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ) => Promise<UUID>;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000" as UUID;

export const rememberHandler: NativeToolHandler = async (
  rawInput,
  runtime: IAgentRuntime,
  message: Memory,
) => {
  const input = (rawInput ?? {}) as Partial<RememberInput>;
  if (typeof input.text !== "string" || input.text.length === 0) {
    return { content: "remember: 'text' is required", is_error: true };
  }

  const rt = runtime as unknown as MemoryWritableRuntime;
  if (typeof rt.createMemory !== "function") {
    return {
      content: "remember: runtime does not expose createMemory.",
      is_error: true,
    };
  }

  const tags = input.category ? [input.category] : undefined;
  const memory: Memory = {
    entityId:
      (rt.agentId as UUID | undefined) ??
      (message?.entityId as UUID | undefined) ??
      NIL_UUID,
    agentId: rt.agentId,
    roomId: (message?.roomId as UUID | undefined) ?? NIL_UUID,
    content: { text: input.text },
    createdAt: Date.now(),
    metadata: {
      type: "custom",
      source: "native-reasoning:remember",
      scope: "private",
      ...(tags ? { tags } : {}),
    } as Memory["metadata"],
  } as Memory;

  try {
    const id = await rt.createMemory(memory, "facts");
    return {
      content: `remembered (id=${id})${input.category ? ` [${input.category}]` : ""}`,
    };
  } catch (err) {
    return {
      content: `remember: createMemory failed: ${(err as Error).message}`,
      is_error: true,
    };
  }
};
