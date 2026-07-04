/**
 * MEMORY action: model-driven create/search/update/delete over the agent's
 * stored memories. Reads MUST match the scope the FACTS provider uses —
 * identity-cluster-expanded entity ids — or a fact the provider surfaces
 * reads back as "0 stored items" here, and deletion becomes unreachable.
 * All model-supplied ids are parsed before touching the database so a bad
 * id becomes a clean handled result, never a raw SQL error in model context.
 */
import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  MemoryType as CoreMemoryType,
  getRelatedEntityIds,
  logger,
  ModelType,
  validateUuid,
} from "@elizaos/core";

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

type UuidParamName = "entityId" | "roomId" | "memoryId";

type ParsedUuidParam =
  | { ok: true; id: UUID | undefined }
  | { ok: false; result: ActionResult };

// error-policy:J3 model-supplied ids arrive as free text ("general", partial
// uuids); parsing before any query keeps drizzle from throwing — and from
// echoing the failed SQL statement back into model context.
function parseUuidParam(
  value: string | undefined,
  name: UuidParamName,
): ParsedUuidParam {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, id: undefined };
  const id = validateUuid(trimmed);
  if (!id) {
    return {
      ok: false,
      result: fail(
        `${name} "${trimmed}" is not a valid UUID. Omit it or use an id from a previous search result.`,
        "MEMORY_INVALID_UUID",
      ),
    };
  }
  return { ok: true, id };
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
    id: memory.id ?? "",
    type,
    text: (content?.text as string) ?? "",
    entityId: memory.entityId,
    roomId: memory.roomId,
    agentId: memory.agentId ?? null,
    createdAt: memory.createdAt ?? 0,
  };
}

/**
 * Confidence for facts the user explicitly asked to store. Higher than the
 * reflection extractor's 0.7 — "remember this" is a direct instruction, not
 * an inferred claim.
 */
const EXPLICIT_MEMORY_CONFIDENCE = 0.95;

async function doCreate(
  runtime: IAgentRuntime,
  message: Memory,
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
  const memoryId = crypto.randomUUID() as UUID;
  const createdAt = Date.now();

  // Persist where the recall read path looks. The FACTS provider — the only
  // default-on read path for user facts — scans the `facts` table scoped to
  // the conversation room and the speaker's entity ids. The previous write
  // (agent-scoped `memories` table in a synthetic manual-memories room) was
  // invisible to it, so the agent acked "I'll remember" and then denied
  // knowing the fact on the next turn.
  await runtime.createMemory(
    {
      id: memoryId,
      entityId: message.entityId ?? agentId,
      agentId,
      roomId: message.roomId,
      content: { text, source: "MEMORY" },
      metadata: {
        type: CoreMemoryType.CUSTOM,
        source: "MEMORY",
        kind: "durable",
        category: kind ?? "user_note",
        confidence: EXPLICIT_MEMORY_CONFIDENCE,
        keywords: tags,
        verificationStatus: "self_reported",
        lastConfirmedAt: new Date(createdAt).toISOString(),
      },
      createdAt,
    } as Memory,
    "facts",
    true,
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

interface MemoryCandidate {
  memory: Memory;
  type: MemoryType;
}

/**
 * Shared read scope for search and delete-by-query. The entity filter is
 * identity-cluster expanded via getRelatedEntityIds — the same expansion the
 * FACTS provider applies — so a fact stored under a cluster sibling of the
 * requested entityId is in scope. A strict-equality filter here made the same
 * fact the provider had just surfaced report as "0 stored items".
 */
async function collectCandidates(
  runtime: IAgentRuntime,
  scope: {
    type?: MemoryType;
    entityId?: UUID;
    roomId?: UUID;
    query?: string;
    limit: number;
  },
): Promise<MemoryCandidate[]> {
  const tables: readonly MemoryType[] = scope.type
    ? [scope.type]
    : MEMORY_TYPES;
  const perTable = Math.max(scope.limit * 2, 200);
  const collected: MemoryCandidate[] = [];

  for (const tableName of tables) {
    const memories = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId: scope.roomId,
      tableName,
      limit: perTable,
    });
    for (const m of memories) collected.push({ memory: m, type: tableName });
  }

  let filtered = collected.filter((c) => {
    const text = (c.memory.content as { text?: string } | undefined)?.text;
    return typeof text === "string" && text.trim().length > 0;
  });

  if (scope.entityId) {
    const clusterIds = new Set<string>(
      await getRelatedEntityIds(runtime, scope.entityId),
    );
    filtered = filtered.filter(
      (c) => c.memory.entityId != null && clusterIds.has(c.memory.entityId),
    );
  }

  if (scope.query) {
    const query = scope.query;
    filtered = filtered.filter((c) => {
      const text =
        (c.memory.content as { text?: string } | undefined)?.text ?? "";
      return scoreText(text, query) > 0;
    });
  }

  filtered.sort(
    (a, b) => (b.memory.createdAt ?? 0) - (a.memory.createdAt ?? 0),
  );
  return filtered;
}

async function doSearch(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  const entityParam = parseUuidParam(params.entityId, "entityId");
  if (!entityParam.ok) return entityParam.result;
  const roomParam = parseUuidParam(params.roomId, "roomId");
  if (!roomParam.ok) return roomParam.result;
  const query = params.query?.trim();
  const limit = clampLimit(params.limit, 50);

  const filtered = await collectCandidates(runtime, {
    type,
    entityId: entityParam.id,
    roomId: roomParam.id,
    query,
    limit,
  });

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
  const memoryParam = parseUuidParam(params.memoryId, "memoryId");
  if (!memoryParam.ok) return memoryParam.result;
  const memoryId = memoryParam.id;
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
  const memoryParam = parseUuidParam(params.memoryId, "memoryId");
  if (!memoryParam.ok) return memoryParam.result;
  const memoryId = memoryParam.id;
  const query = params.query?.trim();
  if (!memoryId && !query) {
    return fail("memoryId or query is required.", "MEMORY_MISSING_ID");
  }
  if (params.confirm !== true) {
    return fail(
      "Refusing to delete: pass confirm:true to acknowledge this destructive action.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  if (memoryId) {
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

  if (!query) {
    return fail("memoryId or query is required.", "MEMORY_MISSING_ID");
  }
  return doDeleteByQuery(runtime, params, query);
}

/**
 * Delete-by-query: "remove that fact" carries no memoryId, so resolve the
 * memory through the same cluster-expanded read scope search uses, then
 * delete. Reflection dedup failures leave several rows with identical text —
 * one logical fact — so all rows of the single matched text are removed.
 * A query that strongly matches more than one distinct text is ambiguous:
 * refuse and list the candidates so the model can delete by exact id.
 */
async function doDeleteByQuery(
  runtime: IAgentRuntime,
  params: MemoryParams,
  query: string,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  const entityParam = parseUuidParam(params.entityId, "entityId");
  if (!entityParam.ok) return entityParam.result;
  const roomParam = parseUuidParam(params.roomId, "roomId");
  if (!roomParam.ok) return roomParam.result;

  const limit = clampLimit(params.limit, 50);
  const candidates = await collectCandidates(runtime, {
    type,
    entityId: entityParam.id,
    roomId: roomParam.id,
    query,
    limit,
  });

  // Deletion needs a stronger bar than search ranking: scoreText >= 1 means
  // the whole phrase matched or every query term matched.
  const matched = candidates.filter((c) => {
    const text =
      (c.memory.content as { text?: string } | undefined)?.text ?? "";
    return scoreText(text, query) >= 1;
  });

  if (matched.length === 0) {
    return fail(`No stored memory matches "${query}".`, "MEMORY_NOT_FOUND");
  }

  const normalize = (c: MemoryCandidate) =>
    ((c.memory.content as { text?: string } | undefined)?.text ?? "")
      .trim()
      .toLowerCase();
  const distinctTexts = new Set(matched.map(normalize));
  if (distinctTexts.size > 1) {
    const lines = matched
      .slice(0, 10)
      .map((c) => toListItem(c.memory, c.type))
      .map((m) => `- [${m.type}] ${m.id}: ${m.text.slice(0, 120)}`);
    return {
      success: false,
      text: [
        `Query "${query}" matches ${distinctTexts.size} distinct memories. Delete by memoryId instead:`,
        ...lines,
      ].join("\n"),
      data: { error: "MEMORY_AMBIGUOUS_QUERY" },
    };
  }

  const deleted: MemoryListItem[] = [];
  for (const c of matched) {
    const id = c.memory.id;
    if (!id) continue;
    await runtime.deleteMemory(id);
    deleted.push(toListItem(c.memory, c.type));
  }

  return {
    success: true,
    text: `Forgot ${deleted.length} memory record(s) matching "${query}": ${
      deleted[0]?.text.slice(0, 120) ?? ""
    }`,
    values: { deletedCount: deleted.length },
    data: {
      actionName: "MEMORY",
      op: "delete" as const,
      query,
      deleted,
    },
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
    "LIST_MEMORIES",
    "SEARCH_MEMORY",
    "REMOVE_MEMORY",
    "MODIFY_MEMORY",
  ],
  description:
    "Manage agent memory records. op:create stores a new memory; op:search filters by type/entityId/roomId/query; op:update edits text and re-embeds (requires confirm:true); op:delete removes a memory by memoryId or by query text match (requires confirm:true).",
  descriptionCompressed:
    "manage agent memory create search update delete; delete by memoryId or query; update/delete require confirm:true",
  routingHint:
    "store/search/edit the agent's OWN memory records about the user or conversation -> MEMORY; do NOT use for open-web lookups -> WEB_SEARCH, for reading messages already in a channel -> MESSAGE (action=search), or for the skill catalog -> SKILL",
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message,
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
          return await doCreate(runtime, message, params);
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
        "search/delete: case-insensitive text match against memory content. delete: resolves the memory to remove when memoryId is unknown.",
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
      description:
        "update/delete: id of the memory to mutate. delete: optional when query is provided.",
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
