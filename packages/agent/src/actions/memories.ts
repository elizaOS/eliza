/**
 * MEMORY — consolidated memory action.
 *
 * Single polymorphic action that dispatches across {create, search, update,
 * delete} ops via in-process runtime APIs only. No HTTP fan-out.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { ChannelType, logger, ModelType, stringToUuid } from "@elizaos/core";

const MEMORY_OPS = ["create", "search", "update", "delete"] as const;
type MemoryOp = (typeof MEMORY_OPS)[number];

const MEMORY_TYPES = ["messages", "memories", "facts", "documents"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface MemoryParams {
  action?: MemoryOp;
  op?: MemoryOp;
  subaction?: MemoryOp;
  text?: string;
  kind?: string;
  tags?: string[];
  type?: MemoryType;
  entityId?: string;
  roomId?: string;
  query?: string;
  limit?: number;
  memoryId?: string;
  confirm?: boolean;
}

interface MemoryListItem {
  id: string;
  type: MemoryType;
  text: string;
  entityId: string | null;
  roomId: string | null;
  agentId: string | null;
  createdAt: number;
}

function fail(text: string, error: string): ActionResult {
  return { success: false, text, data: { error } };
}

function normalizeMemoryOp(params: MemoryParams): MemoryOp | undefined {
  const candidate = params.action ?? params.subaction ?? params.op;
  return candidate && MEMORY_OPS.includes(candidate) ? candidate : undefined;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

function scoreText(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!t || !q) return 0;
  const terms = q
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const whole = t.includes(q) ? 1 : 0;
  if (terms.length === 0) return whole;
  let matches = 0;
  for (const term of terms) if (t.includes(term)) matches += 1;
  return whole + matches / terms.length;
}

function toListItem(memory: Memory, type: MemoryType): MemoryListItem {
  const content = memory.content as Record<string, unknown> | undefined;
  return {
    id: (memory.id as string) ?? "",
    type,
    text: (content?.text as string) ?? "",
    entityId: (memory.entityId as string) ?? null,
    roomId: (memory.roomId as string) ?? null,
    agentId: (memory.agentId as string) ?? null,
    createdAt: memory.createdAt ?? 0,
  };
}

async function doCreate(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!text) return fail("text is required.", "MEMORY_MISSING_TEXT");

  const kind =
    typeof params.kind === "string" && params.kind.trim()
      ? params.kind.trim()
      : undefined;
  const tags = Array.isArray(params.tags)
    ? params.tags.filter(
        (t): t is string => typeof t === "string" && t.trim().length > 0,
      )
    : [];

  const agentId = runtime.agentId as UUID;
  const roomId = stringToUuid(
    `${runtime.character?.name ?? "eliza"}-manual-memories-room`,
  ) as UUID;
  const memoryId = crypto.randomUUID() as UUID;
  const createdAt = Date.now();

  const content: Record<string, unknown> = { text, source: "MEMORY" };
  if (kind) content.kind = kind;
  if (tags.length > 0) content.tags = tags;

  await runtime
    .ensureRoomExists({
      id: roomId,
      agentId,
      name: "manual-memories",
      source: "agent",
      type: ChannelType.DM,
      worldId: stringToUuid(`${agentId}-manual-memories-world`) as UUID,
    })
    .catch(() => undefined);

  await runtime.createMemory(
    {
      id: memoryId,
      entityId: agentId,
      agentId,
      roomId,
      content,
      createdAt,
    } as Memory,
    "memories",
  );

  return {
    success: true,
    text: `Stored memory ${memoryId}.`,
    values: { memoryId, kind: kind ?? null, tagCount: tags.length },
    data: {
      actionName: "MEMORY",
      op: "create" as const,
      memoryId,
      text,
      kind: kind ?? null,
      tags,
      createdAt,
    },
  };
}

async function doSearch(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  const entityId = params.entityId?.trim() as UUID | undefined;
  const roomId = params.roomId?.trim() as UUID | undefined;
  const query = params.query?.trim();
  const limit = clampLimit(params.limit, 50);

  const tables: readonly MemoryType[] = type ? [type] : MEMORY_TYPES;
  const perTable = Math.max(limit * 2, 200);
  const collected: { memory: Memory; type: MemoryType }[] = [];

  for (const tableName of tables) {
    const memories = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId,
      tableName,
      limit: perTable,
    });
    for (const m of memories) collected.push({ memory: m, type: tableName });
  }

  let filtered = collected.filter((c) => {
    const text = (c.memory.content as { text?: string } | undefined)?.text;
    return typeof text === "string" && text.trim().length > 0;
  });

  if (entityId)
    filtered = filtered.filter((c) => c.memory.entityId === entityId);

  if (query) {
    filtered = filtered.filter((c) => {
      const text =
        (c.memory.content as { text?: string } | undefined)?.text ?? "";
      return scoreText(text, query) > 0;
    });
  }

  filtered.sort(
    (a, b) => (b.memory.createdAt ?? 0) - (a.memory.createdAt ?? 0),
  );

  const total = filtered.length;
  const items = filtered
    .slice(0, limit)
    .map((c) => toListItem(c.memory, c.type));
  const lines = items
    .slice(0, 25)
    .map((m) => `- [${m.type}] ${m.id}: ${m.text.slice(0, 120)}`);

  return {
    success: true,
    text: [
      `Found ${items.length} memory item(s) (total: ${total}).`,
      ...lines,
    ].join("\n"),
    values: { count: items.length, total },
    data: {
      actionName: "MEMORY",
      op: "search" as const,
      memories: items,
      total,
      limit,
    },
  };
}

async function doUpdate(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const memoryId = params.memoryId?.trim() as UUID | undefined;
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!memoryId) return fail("memoryId is required.", "MEMORY_MISSING_ID");
  if (!text) return fail("text is required.", "MEMORY_MISSING_TEXT");
  if (params.confirm !== true) {
    return fail(
      "Refusing to update: pass confirm:true to acknowledge overwriting an existing memory.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  const existing = await runtime.getMemoryById(memoryId);
  if (!existing) {
    return fail(`Memory ${memoryId} was not found.`, "MEMORY_NOT_FOUND");
  }

  const existingContent =
    (existing.content as Record<string, unknown> | undefined) ?? {};
  const nextContent = { ...existingContent, text };

  const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, { text });
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return fail(
      "Embedding model returned no vector.",
      "MEMORY_EMBEDDING_FAILED",
    );
  }

  await runtime.updateMemory({
    id: memoryId,
    content: nextContent,
    embedding,
  });

  const updated = await runtime.getMemoryById(memoryId);
  return {
    success: true,
    text: `Updated memory ${memoryId}.`,
    values: { memoryId },
    data: {
      actionName: "MEMORY",
      op: "update" as const,
      memoryId,
      memory: updated ?? null,
    },
  };
}

async function doDelete(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const memoryId = params.memoryId?.trim() as UUID | undefined;
  if (!memoryId) return fail("memoryId is required.", "MEMORY_MISSING_ID");
  if (params.confirm !== true) {
    return fail(
      "Refusing to delete: pass confirm:true to acknowledge this destructive action.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  const existing = await runtime.getMemoryById(memoryId);
  if (!existing) {
    return fail(`Memory ${memoryId} was not found.`, "MEMORY_NOT_FOUND");
  }

  await runtime.deleteMemory(memoryId);
  return {
    success: true,
    text: `Forgot memory ${memoryId}.`,
    values: { memoryId },
    data: { actionName: "MEMORY", op: "delete" as const, memoryId },
  };
}

export const memoryAction: Action = {
  name: "MEMORY",
  contexts: ["memory", "documents", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    // Old leaf action names
    "CREATE_MEMORY",
    "SEARCH_MEMORIES",
    "UPDATE_MEMORY",
    "DELETE_MEMORY",
    "RECALL_MEMORY_FILTERED",
    "FORGET_MEMORY",
    "EDIT_MEMORY",
    // Common aliases
    "MEMORIZE",
    "REMEMBER_THIS",
    "STORE_MEMORY",
    "WRITE_MEMORY",
    "SAVE_MEMORY",
    "BROWSE_MEMORIES",
    "FILTER_MEMORIES",
    "FIND_MEMORIES",
    "REMOVE_MEMORY",
    "MODIFY_MEMORY",
  ],
  description:
    "Manage agent memory records. op:create stores a new memory; op:search filters by type/entityId/roomId/query; op:update edits text and re-embeds (requires confirm:true); op:delete removes a memory (requires confirm:true).",
  descriptionCompressed:
    "manage agent memory create search update delete; update/delete require confirm:true",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = ((options as HandlerOptions | undefined)?.parameters ??
      {}) as MemoryParams;
    const op = normalizeMemoryOp(params);
    if (!op) {
      return fail(
        `op/subaction is required and must be one of ${MEMORY_OPS.join(", ")}.`,
        "MEMORY_INVALID",
      );
    }
    try {
      switch (op) {
        case "create":
          return await doCreate(runtime, params);
        case "search":
          return await doSearch(runtime, params);
        case "update":
          return await doUpdate(runtime, params);
        case "delete":
          return await doDelete(runtime, params);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[memory:${op}] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to ${op} memory: ${msg}`,
        data: { error: `MEMORY_${op.toUpperCase()}_FAILED` },
      };
    }
  },
  parameters: [
    {
      name: "action",
      description:
        "Operation to perform. One of: create, search, update, delete.",
      required: false,
      schema: { type: "string" as const, enum: [...MEMORY_OPS] },
    },
    {
      name: "text",
      description:
        "create: content to store. update: replacement text body for the memory.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "kind",
      description:
        'create: optional category label, e.g. "fact", "preference".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "tags",
      description: "create: optional list of string tags.",
      required: false,
      schema: { type: "array" as const, items: { type: "string" as const } },
    },
    {
      name: "type",
      description: "search: filter by memory table type.",
      required: false,
      schema: { type: "string" as const, enum: [...MEMORY_TYPES] },
    },
    {
      name: "entityId",
      description: "search: filter to memories owned by this entity id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description: "search: filter to memories from this room id.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "search: case-insensitive text match against memory content.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "search: maximum results to return (1-200).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "memoryId",
      description: "update/delete: id of the memory to mutate.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "confirm",
      description:
        "update/delete: must be true to proceed with the destructive operation.",
      required: false,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Remember that I prefer dark mode." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Stored memory abc-123.", action: "MEMORY" },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Find recent memories that mention scheduling." },
      },
      {
        name: "{{agentName}}",
        content: { text: "Found N memory item(s)...", action: "MEMORY" },
      },
    ],
  ],
};
