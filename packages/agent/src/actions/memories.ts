/**
 * Memory introspection actions.
 *
 * SEARCH_MEMORIES (was RECALL_MEMORY_FILTERED) → GET /api/memories/browse or /api/memories/by-entity/:id
 * DELETE_MEMORY   (was FORGET_MEMORY)          → DELETE /api/memories/:id
 * UPDATE_MEMORY   (was EDIT_MEMORY)            → PATCH /api/memories/:id (server re-embeds)
 */

import type { Action, ActionResult, HandlerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/shared";

function getApiBase(): string {
  return `http://localhost:${resolveServerOnlyPort(process.env)}`;
}

const MEMORY_TYPES = ["messages", "memories", "facts", "documents"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface RecallMemoryParams {
  type?: MemoryType;
  entityId?: string;
  roomId?: string;
  query?: string;
  limit?: number;
}

interface MemoryItemShape {
  id: string;
  type?: string;
  entityId?: string;
  roomId?: string;
  text?: string;
  createdAt?: string | number;
}

interface MemoryBrowseResponseShape {
  memories: MemoryItemShape[];
  total: number;
  limit: number;
  offset: number;
}

export const recallMemoryFilteredAction: Action = {
  name: "SEARCH_MEMORIES",
  contexts: ["memory", "knowledge", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "RECALL_MEMORY_FILTERED",
    "BROWSE_MEMORIES",
    "FILTER_MEMORIES",
    "FIND_MEMORIES",
  ],
  description:
    "Recall memories filtered by type, entityId, roomId, or text query. Routes to /api/memories/by-entity when entityId is supplied; otherwise /api/memories/browse.",
  descriptionCompressed:
    "recall memory filter type, entityid, roomid, text query route / api/memories/by-entity entityid suppli; otherwise / api/memories/browse",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | RecallMemoryParams
      | undefined;

    const type =
      params?.type && MEMORY_TYPES.includes(params.type)
        ? params.type
        : undefined;
    const entityId = params?.entityId?.trim();
    const roomId = params?.roomId?.trim();
    const query = params?.query?.trim();
    const limit =
      params?.limit != null
        ? Math.max(1, Math.min(200, Math.floor(params.limit)))
        : undefined;

    const search = new URLSearchParams();
    if (type) search.set("type", type);
    if (limit !== undefined) search.set("limit", String(limit));

    let url: string;
    if (entityId) {
      url = `${getApiBase()}/api/memories/by-entity/${encodeURIComponent(entityId)}${
        search.toString() ? `?${search.toString()}` : ""
      }`;
    } else {
      if (roomId) search.set("roomId", roomId);
      if (query) search.set("q", query);
      const qs = search.toString();
      url = `${getApiBase()}/api/memories/browse${qs ? `?${qs}` : ""}`;
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to recall memories: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as MemoryBrowseResponseShape;
      const memories = data.memories ?? [];
      const lines = memories.slice(0, 25).map((memory) => {
        const text = (memory.text ?? "").slice(0, 120);
        return `- [${memory.type ?? "?"}] ${memory.id}: ${text}`;
      });
      return {
        success: true,
        text: [
          `Found ${memories.length} memory item(s) (total: ${data.total ?? memories.length}).`,
          ...lines,
        ].join("\n"),
        values: { count: memories.length, total: data.total ?? null },
        data: {
          actionName: "SEARCH_MEMORIES",
          memories,
          total: data.total,
          offset: data.offset,
          limit: data.limit,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[recall-memory-filtered] failed: ${msg}`);
      return { success: false, text: `Failed to recall memories: ${msg}` };
    }
  },
  parameters: [
    {
      name: "type",
      description: "Memory type filter.",
      required: false,
      schema: { type: "string" as const, enum: [...MEMORY_TYPES] },
    },
    {
      name: "entityId",
      description:
        "Optional entity ID. When supplied, routes to /api/memories/by-entity.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "Optional room ID filter (browse only).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description: "Optional text search query (browse only).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum results to return (1-200).",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Find recent memories that mention scheduling." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Found N memory item(s)...",
          action: "SEARCH_MEMORIES",
        },
      },
    ],
  ],
};

// ---------------------------------------------------------------------------
// FORGET_MEMORY
// ---------------------------------------------------------------------------

interface ForgetMemoryParams {
  memoryId?: string;
  confirm?: boolean;
}

export const forgetMemoryAction: Action = {
  name: "DELETE_MEMORY",
  contexts: ["memory", "knowledge", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["FORGET_MEMORY", "REMOVE_MEMORY"],
  description:
    "Permanently delete a memory by id. Requires explicit confirm:true.",
  descriptionCompressed:
    "permanently delete memory id require explicit confirm: true",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | ForgetMemoryParams
      | undefined;
    const memoryId = params?.memoryId?.trim();
    if (!memoryId) {
      return {
        success: false,
        text: "memoryId is required.",
        values: { error: "MISSING_MEMORY_ID" },
      };
    }
    if (params?.confirm !== true) {
      return {
        success: false,
        text: "Refusing to forget: pass confirm:true to acknowledge this destructive action.",
        values: { error: "CONFIRMATION_REQUIRED" },
      };
    }

    const url = `${getApiBase()}/api/memories/${encodeURIComponent(memoryId)}`;
    try {
      const resp = await fetch(url, {
        method: "DELETE",
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 404) {
        return {
          success: false,
          text: `Memory ${memoryId} was not found.`,
          values: { error: "NOT_FOUND" },
        };
      }
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to forget memory: HTTP ${resp.status}`,
        };
      }
      return {
        success: true,
        text: `Forgot memory ${memoryId}.`,
        values: { memoryId },
        data: { actionName: "DELETE_MEMORY", memoryId },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[forget-memory] failed: ${msg}`);
      return { success: false, text: `Failed to forget memory: ${msg}` };
    }
  },
  parameters: [
    {
      name: "memoryId",
      description: "ID of the memory to delete.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description: "Must be true to proceed with deletion.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [],
};

// ---------------------------------------------------------------------------
// EDIT_MEMORY
// ---------------------------------------------------------------------------

interface EditMemoryParams {
  memoryId?: string;
  text?: string;
  confirm?: boolean;
}

interface EditMemoryResponseShape {
  updated?: boolean;
  id?: string;
  memory?: MemoryItemShape | Record<string, unknown>;
}

export const editMemoryAction: Action = {
  name: "UPDATE_MEMORY",
  contexts: ["memory", "knowledge", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: ["EDIT_MEMORY", "MODIFY_MEMORY"],
  description:
    "Edit the text of an existing memory. Server re-embeds the new text. Requires explicit confirm:true.",
  descriptionCompressed:
    "edit text exist memory server re-embed new text require explicit confirm: true",
  validate: async () => true,
  handler: async (
    _runtime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | EditMemoryParams
      | undefined;
    const memoryId = params?.memoryId?.trim();
    const text = params?.text;
    if (!memoryId) {
      return {
        success: false,
        text: "memoryId is required.",
        values: { error: "MISSING_MEMORY_ID" },
      };
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return {
        success: false,
        text: "text is required.",
        values: { error: "MISSING_TEXT" },
      };
    }
    if (params?.confirm !== true) {
      return {
        success: false,
        text: "Refusing to edit: pass confirm:true to acknowledge overwriting an existing memory.",
        values: { error: "CONFIRMATION_REQUIRED" },
      };
    }

    const url = `${getApiBase()}/api/memories/${encodeURIComponent(memoryId)}`;
    try {
      const resp = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30_000),
      });
      if (resp.status === 404) {
        return {
          success: false,
          text: `Memory ${memoryId} was not found.`,
          values: { error: "NOT_FOUND" },
        };
      }
      if (!resp.ok) {
        return {
          success: false,
          text: `Failed to edit memory: HTTP ${resp.status}`,
        };
      }
      const data = (await resp.json()) as EditMemoryResponseShape;
      return {
        success: true,
        text: `Updated memory ${memoryId}.`,
        values: { memoryId },
        data: {
          actionName: "UPDATE_MEMORY",
          memoryId,
          memory: data.memory ?? null,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[edit-memory] failed: ${msg}`);
      return { success: false, text: `Failed to edit memory: ${msg}` };
    }
  },
  parameters: [
    {
      name: "memoryId",
      description: "ID of the memory to edit.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "New text body for the memory.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description: "Must be true to proceed with the edit.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [],
};
