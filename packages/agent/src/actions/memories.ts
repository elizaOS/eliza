/**
 * MEMORY action: model-driven create/search/update/delete over the agent's
 * stored memories. Reads MUST match the scope the FACTS provider uses —
 * identity-cluster-expanded entity ids — or a fact the provider surfaces
 * reads back as "0 stored items" here, and deletion becomes unreachable.
 * All model-supplied ids are parsed before touching the database so a bad
 * id becomes a clean handled result, never a raw SQL error in model context.
 */
import { createHash } from "node:crypto";
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
  ElizaError,
  getRelatedEntityIds,
  logger,
  ModelType,
  toWellFormedUnicode,
  validateUuid,
} from "@elizaos/core";

const MEMORY_OPS = ["create", "search", "update", "delete"] as const;
type MemoryOp = (typeof MEMORY_OPS)[number];

const MEMORY_TYPES = ["messages", "memories", "facts", "documents"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

const UUID_SCHEMA_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

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
  offset?: number;
  snapshot?: string;
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

const SEARCH_QUERY_STOP_WORDS = new Set([
  "a",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

function fail(
  text: string,
  error: string,
  context?: Record<string, unknown>,
): ActionResult {
  return { success: false, text, data: { error, ...context } };
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

function scoreText(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!t || !q) return 0;
  const terms = [
    ...new Set(
      q
        .split(/[^\p{L}\p{N}]+/u)
        .filter(
          (term) => term.length >= 2 && !SEARCH_QUERY_STOP_WORDS.has(term),
        ),
    ),
  ];
  const whole = t.includes(q) ? 1 : 0;
  if (terms.length === 0) return whole;
  const textTerms = new Set(t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  let matches = 0;
  for (const term of terms) if (textTerms.has(term)) matches += 1;
  const requiredMatches = terms.length >= 3 ? 2 : 1;
  if (whole === 0 && matches < requiredMatches) return 0;
  return whole + matches / terms.length;
}

function searchableMemoryText(memory: Memory): string {
  const text = memory.content.text ?? "";
  const attachments = (memory.content.attachments ?? []).map((attachment) => {
    const label =
      attachment.filename ?? attachment.title ?? attachment.id ?? "attachment";
    const mediaType = attachment.mimeType ?? attachment.contentType;
    const readableContent = attachment.text ?? attachment.description;
    return `[attachment: ${label}${mediaType ? `; ${mediaType}` : ""}${readableContent ? `; ${readableContent}` : ""}]`;
  });
  return [text, ...attachments].filter(Boolean).join(" ");
}

function toListItem(memory: Memory, type: MemoryType): MemoryListItem {
  return {
    id: memory.id ?? "",
    type,
    text: searchableMemoryText(memory),
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

interface CandidateScan {
  matches: MemoryCandidate[];
  tables: readonly MemoryType[];
  scanned: number;
}

const COMPLETE_MEMORY_PAGE_SIZE = 10_000;
export const MAX_MEMORY_PAGE_ITEMS = 50;
export const MAX_MEMORY_ACTION_RESULT_CHARS = 256 * 1024;

function traversalError(
  code: string,
  context: Record<string, unknown>,
): ElizaError {
  return new ElizaError(
    "Memory traversal could not prove a complete snapshot",
    {
      code,
      context,
    },
  );
}

function compareMemoryTuple(left: Memory, right: Memory): number {
  const leftCreatedAt = left.createdAt;
  const rightCreatedAt = right.createdAt;
  if (
    typeof leftCreatedAt !== "number" ||
    typeof rightCreatedAt !== "number" ||
    !Number.isSafeInteger(leftCreatedAt) ||
    !Number.isSafeInteger(rightCreatedAt)
  ) {
    throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", {
      leftId: left.id,
      rightId: right.id,
    });
  }
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
  return String(right.id)
    .toLowerCase()
    .localeCompare(String(left.id).toLowerCase());
}

function memoryPageSnapshot(items: readonly MemoryListItem[]): string {
  const hash = createHash("sha256");
  for (const item of items) {
    const canonical = JSON.stringify([
      item.id,
      item.type,
      item.text,
      item.entityId,
      item.roomId,
      item.agentId,
      item.createdAt,
    ]);
    hash.update(String(Buffer.byteLength(canonical)));
    hash.update(":");
    hash.update(canonical);
  }
  return hash.digest("hex");
}

async function scanCompleteMemoryTable(
  runtime: IAgentRuntime,
  tableName: MemoryType,
  roomId: UUID | undefined,
): Promise<Memory[]> {
  const memories: Memory[] = [];
  const seen = new Set<string>();
  let cursor: { createdAt: number; id: UUID } | undefined;
  let previous: Memory | undefined;

  while (true) {
    const page = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId,
      tableName,
      limit: COMPLETE_MEMORY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      orderBy: "createdAt",
      orderDirection: "desc",
      includeEmbedding: false,
    });
    if (page.length > COMPLETE_MEMORY_PAGE_SIZE) {
      throw traversalError("MEMORY_TRAVERSAL_PAGE_INVALID", {
        tableName,
        pageLength: page.length,
      });
    }
    if (page.length === 0) break;

    for (const memory of page) {
      const id = validateUuid(memory.id);
      if (!id || !Number.isSafeInteger(memory.createdAt)) {
        throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", {
          tableName,
          memoryId: memory.id,
          createdAt: memory.createdAt,
        });
      }
      if (seen.has(id)) {
        throw traversalError("MEMORY_TRAVERSAL_REPEATED_ROW", {
          tableName,
          memoryId: id,
        });
      }
      if (previous && compareMemoryTuple(previous, memory) >= 0) {
        throw traversalError("MEMORY_TRAVERSAL_ORDER_INVALID", {
          tableName,
          previousId: previous.id,
          memoryId: id,
        });
      }
      seen.add(id);
      memories.push(memory);
      previous = memory;
    }

    if (page.length < COMPLETE_MEMORY_PAGE_SIZE) break;
    const last = page.at(-1);
    const lastId = validateUuid(last?.id);
    if (!last || !lastId || !Number.isSafeInteger(last.createdAt)) {
      throw traversalError("MEMORY_TRAVERSAL_CURSOR_INVALID", { tableName });
    }
    const nextCursor = { createdAt: last.createdAt as number, id: lastId };
    if (
      cursor &&
      cursor.createdAt === nextCursor.createdAt &&
      cursor.id === nextCursor.id
    ) {
      throw traversalError("MEMORY_TRAVERSAL_CURSOR_STALLED", {
        tableName,
        cursor,
      });
    }
    cursor = nextCursor;
  }
  return memories;
}

async function readStableCompleteMemoryTable(
  runtime: IAgentRuntime,
  tableName: MemoryType,
  roomId: UUID | undefined,
): Promise<Memory[]> {
  const countParams = {
    agentId: runtime.agentId as UUID,
    ...(roomId ? { roomId } : {}),
    tableName,
  };
  const before = await runtime.countMemories(countParams);
  const first = await scanCompleteMemoryTable(runtime, tableName, roomId);
  const between = await runtime.countMemories(countParams);
  const second = await scanCompleteMemoryTable(runtime, tableName, roomId);
  const after = await runtime.countMemories(countParams);
  const firstIds = first.map((memory) => memory.id);
  const secondIds = second.map((memory) => memory.id);
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before !== between ||
    before !== after ||
    first.length !== before ||
    second.length !== before ||
    firstIds.some((id, index) => id !== secondIds[index])
  ) {
    throw traversalError("MEMORY_TRAVERSAL_INVENTORY_CHANGED", {
      tableName,
      before,
      between,
      after,
      firstLength: first.length,
      secondLength: second.length,
    });
  }
  return second;
}

const RECALL_TERMINAL_SETTING = "ELIZA_RECALL_SHORT_CIRCUIT";

function recallTerminalEnabled(runtime: IAgentRuntime): boolean {
  const raw = runtime.getSetting(RECALL_TERMINAL_SETTING);
  return typeof raw === "boolean"
    ? raw
    : /^(?:1|true|yes|on)$/iu.test(String(raw ?? "").trim());
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
  },
): Promise<CandidateScan> {
  const tables: readonly MemoryType[] = scope.type
    ? [scope.type]
    : MEMORY_TYPES;
  const collected: MemoryCandidate[] = [];

  for (const tableName of tables) {
    const memories = await readStableCompleteMemoryTable(
      runtime,
      tableName,
      scope.roomId,
    );
    for (const m of memories) collected.push({ memory: m, type: tableName });
  }

  let filtered = collected.filter((c) => {
    return searchableMemoryText(c.memory).trim().length > 0;
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
      return scoreText(searchableMemoryText(c.memory), query) > 0;
    });
  }

  filtered.sort((a, b) => {
    if (scope.query) {
      const leftText = searchableMemoryText(a.memory);
      const rightText = searchableMemoryText(b.memory);
      const relevance =
        scoreText(rightText, scope.query) - scoreText(leftText, scope.query);
      if (relevance !== 0) return relevance;
    }
    return (b.memory.createdAt ?? 0) - (a.memory.createdAt ?? 0);
  });
  return { matches: filtered, tables, scanned: collected.length };
}

/** Names every narrowing that was applied, so an empty result can say why. */
function describeSearchScope(scope: {
  type?: MemoryType;
  entityId?: UUID;
  roomId?: UUID;
  query?: string;
}): string {
  const parts: string[] = [];
  if (scope.query) parts.push(`query="${scope.query}"`);
  if (scope.type) parts.push(`type=${scope.type}`);
  if (scope.entityId) parts.push(`entityId=${scope.entityId}`);
  if (scope.roomId) parts.push(`roomId=${scope.roomId}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** States the complete storage scope proven before applying caller filters. */
function describeCompleteScan(scan: CandidateScan): string {
  return `Scanned all ${scan.scanned} stored row(s) across ${scan.tables.join(", ")} before filtering.`;
}

async function doSearch(
  runtime: IAgentRuntime,
  params: MemoryParams,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  // Read-only salvage (matrix F16): a mangled planner-copied UUID is an
  // unusable *filter*, and failing the whole search over it turns a
  // recoverable turn into a failed one. Searching without the filter is a
  // superset of the intended scope, so ignore the id and say so in the
  // result. Destructive ops keep parseUuidParam's hard fail — a mangled id
  // must never widen a delete's scope.
  const entityParam = parseUuidParam(params.entityId, "entityId");
  const roomParam = parseUuidParam(params.roomId, "roomId");
  const ignoredIdNotes: string[] = [];
  if (!entityParam.ok) {
    ignoredIdNotes.push(
      `ignored invalid entityId "${params.entityId?.trim()}" (searched all entities)`,
    );
  }
  if (!roomParam.ok) {
    ignoredIdNotes.push(
      `ignored invalid roomId "${params.roomId?.trim()}" (searched all rooms)`,
    );
  }
  const query = params.query?.trim();
  const limit = params.limit;
  const offset = params.offset ?? 0;
  const requestedSnapshot = params.snapshot?.trim();
  if (
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (limit === undefined && offset !== 0) ||
    (offset > 0 && !requestedSnapshot)
  ) {
    return fail(
      "search limit must be a positive integer, and a continuation offset requires limit and snapshot.",
      "MEMORY_INVALID_PAGE",
    );
  }
  if (limit !== undefined && limit > MAX_MEMORY_PAGE_ITEMS) {
    return fail(
      `search limit ${limit} exceeds the maximum page size of ${MAX_MEMORY_PAGE_ITEMS}. Retry with a smaller limit.`,
      "MEMORY_PAGE_LIMIT_EXCEEDED",
      { requestedLimit: limit, maxLimit: MAX_MEMORY_PAGE_ITEMS },
    );
  }

  const scope = {
    type,
    entityId: entityParam.ok ? entityParam.id : undefined,
    roomId: roomParam.ok ? roomParam.id : undefined,
    query,
  };
  const scan = await collectCandidates(runtime, scope);

  const allItems = scan.matches.map((candidate) =>
    toListItem(candidate.memory, candidate.type),
  );
  const totalMatches = allItems.length;
  const snapshot = memoryPageSnapshot(allItems);
  if (requestedSnapshot && requestedSnapshot !== snapshot) {
    return fail(
      "The ordered memory matches changed after the previous page. Restart this search at offset 0.",
      "MEMORY_PAGE_SNAPSHOT_CHANGED",
    );
  }
  if (limit === undefined && totalMatches > MAX_MEMORY_PAGE_ITEMS) {
    return fail(
      `The complete search has ${totalMatches} matches, which exceeds the maximum safe result size of ${MAX_MEMORY_PAGE_ITEMS} records. Retry with limit at most ${MAX_MEMORY_PAGE_ITEMS}.`,
      "MEMORY_SEARCH_REQUIRES_PAGINATION",
      {
        totalMatches,
        maxLimit: MAX_MEMORY_PAGE_ITEMS,
        suggestedLimit: Math.min(20, MAX_MEMORY_PAGE_ITEMS),
        snapshot,
      },
    );
  }
  const items =
    limit === undefined ? allItems : allItems.slice(offset, offset + limit);
  const nextOffset =
    limit !== undefined && offset + items.length < totalMatches
      ? offset + items.length
      : undefined;
  // The text projection carries enough of each hit for model reasoning; the
  // complete records remain machine data for state and trajectory consumers.
  const lines = items.map(
    (m) =>
      `- [${m.type}] ${m.id} at ${new Date(m.createdAt).toISOString()}: ${toWellFormedUnicode(m.text)}`,
  );
  const userFacingText = items.length
    ? [
        `I found ${items.length} matching memory record(s):`,
        ...items.map(
          (item) =>
            `- [${item.type}] at ${new Date(item.createdAt).toISOString()}: ${toWellFormedUnicode(item.text)}`,
        ),
      ].join("\n")
    : undefined;

  const renderNote =
    limit === undefined
      ? `Showing all ${lines.length} match(es) found in the complete scan`
      : `Showing ${lines.length} match(es) at offset ${offset} of ${totalMatches} found in the complete scan`;
  const continuationNote =
    nextOffset === undefined
      ? []
      : [
          `More matches remain. To continue losslessly, call MEMORY_SEARCH with the same filters, limit=${limit}, offset=${nextOffset}, snapshot=${snapshot}.`,
        ];

  const result: ActionResult = {
    success: true,
    text: [
      `${renderNote} (filters: ${describeSearchScope(scope)}).`,
      ...(ignoredIdNotes.length > 0
        ? [`Note: ${ignoredIdNotes.join("; ")}.`]
        : []),
      describeCompleteScan(scan),
      ...lines,
      ...continuationNote,
    ].join("\n"),
    ...(userFacingText &&
    nextOffset === undefined &&
    recallTerminalEnabled(runtime)
      ? {
          userFacingText,
          verifiedUserFacing: true,
          turnComplete: true,
        }
      : {}),
    values: {
      count: items.length,
      rendered: lines.length,
      totalMatches,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
    data: {
      actionName: "MEMORY",
      op: "search" as const,
      memories: items,
      totalMatches,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
    promptData: {
      actionName: "MEMORY",
      op: "search" as const,
      totalMatches,
      rendered: lines.length,
      scanned: scan.scanned,
      offset,
      nextOffset: nextOffset ?? null,
      snapshot,
    },
  };
  const serializedChars = JSON.stringify(result).length;
  if (serializedChars > MAX_MEMORY_ACTION_RESULT_CHARS) {
    if (limit === undefined) {
      return fail(
        `The complete search result requires ${serializedChars} characters, exceeding the safe action-result budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Retry with an explicit page limit.`,
        "MEMORY_SEARCH_REQUIRES_PAGINATION",
        {
          totalMatches,
          renderedChars: serializedChars,
          maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
          suggestedLimit: Math.min(20, MAX_MEMORY_PAGE_ITEMS),
          snapshot,
        },
      );
    }
    if (items.length === 1) {
      return fail(
        `Memory ${items[0].id} alone requires ${serializedChars} action-result characters, exceeding the safe budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Narrow the search or use a provider with a larger input boundary.`,
        "MEMORY_RECORD_EXCEEDS_PAGE_BUDGET",
        {
          memoryId: items[0].id,
          renderedChars: serializedChars,
          maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
        },
      );
    }
    const suggestedLimit = Math.max(
      1,
      Math.min(
        items.length - 1,
        Math.floor(
          (items.length * MAX_MEMORY_ACTION_RESULT_CHARS) / serializedChars,
        ),
      ),
    );
    return fail(
      `The requested page requires ${serializedChars} action-result characters, exceeding the safe budget of ${MAX_MEMORY_ACTION_RESULT_CHARS}. Retry with limit=${suggestedLimit}.`,
      "MEMORY_PAGE_RESULT_TOO_LARGE",
      {
        requestedLimit: limit,
        suggestedLimit,
        renderedChars: serializedChars,
        maxResultChars: MAX_MEMORY_ACTION_RESULT_CHARS,
        snapshot,
      },
    );
  }
  return result;
}

async function doUpdate(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
): Promise<ActionResult> {
  const memoryParam = parseUuidParam(params.memoryId, "memoryId");
  if (!memoryParam.ok) return memoryParam.result;
  const memoryId = memoryParam.id;
  const query = params.query?.trim();
  const text = typeof params.text === "string" ? params.text.trim() : "";
  if (!memoryId && !query) {
    return fail("memoryId or query is required.", "MEMORY_MISSING_ID");
  }
  if (!text) return fail("text is required.", "MEMORY_MISSING_TEXT");
  if (params.confirm !== true) {
    return fail(
      "Refusing to update: pass confirm:true to acknowledge overwriting an existing memory.",
      "MEMORY_CONFIRMATION_REQUIRED",
    );
  }

  let existingMemories: Memory[];
  if (memoryId) {
    const existing = await runtime.getMemoryById(memoryId);
    if (!existing) {
      return fail(`Memory ${memoryId} was not found.`, "MEMORY_NOT_FOUND");
    }
    existingMemories = [existing];
  } else {
    const scan = await collectCandidates(runtime, {
      type:
        params.type && MEMORY_TYPES.includes(params.type)
          ? params.type
          : undefined,
      entityId: message.entityId,
      query,
    });
    const matched = scan.matches.filter((candidate) => {
      const candidateText =
        (candidate.memory.content as { text?: string } | undefined)?.text ?? "";
      return scoreText(candidateText, query ?? "") >= 1;
    });
    if (matched.length === 0) {
      return fail(
        `No stored memory matches "${query}". ${describeCompleteScan(scan)}`,
        "MEMORY_NOT_FOUND",
      );
    }
    const distinctTexts = new Set(
      matched.map((candidate) =>
        (
          (candidate.memory.content as { text?: string } | undefined)?.text ??
          ""
        )
          .trim()
          .toLowerCase(),
      ),
    );
    if (distinctTexts.size > 1) {
      const lines = matched.map((candidate) => {
        const item = toListItem(candidate.memory, candidate.type);
        return `- [${item.type}] ${item.id}: ${toWellFormedUnicode(item.text)}`;
      });
      return {
        success: false,
        text: [
          `Query "${query}" matches ${distinctTexts.size} distinct memories. Update by memoryId instead:`,
          ...lines,
        ].join("\n"),
        data: { error: "MEMORY_AMBIGUOUS_QUERY" },
      };
    }
    existingMemories = matched.map((candidate) => candidate.memory);
  }

  const updatedIds: UUID[] = [];
  for (const existing of existingMemories) {
    if (!existing.id) continue;
    const existingContent =
      (existing.content as Record<string, unknown> | undefined) ?? {};
    const nextContent = { ...existingContent, text };
    let embedding: number[] | undefined;
    if (Array.isArray(existing.embedding) && existing.embedding.length > 0) {
      const regenerated = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
        text,
      });
      if (!Array.isArray(regenerated) || regenerated.length === 0) {
        return fail(
          "Embedding model returned no vector.",
          "MEMORY_EMBEDDING_FAILED",
        );
      }
      embedding = regenerated;
    }

    await runtime.updateMemory({
      id: existing.id,
      content: nextContent,
      ...(embedding ? { embedding } : {}),
    });
    updatedIds.push(existing.id);
  }

  const primaryMemoryId = updatedIds[0];
  const updated = primaryMemoryId
    ? await runtime.getMemoryById(primaryMemoryId)
    : null;
  return {
    success: true,
    text: `Updated ${updatedIds.length} memory record(s).`,
    values: { memoryId: primaryMemoryId, updatedCount: updatedIds.length },
    data: {
      actionName: "MEMORY",
      op: "update" as const,
      memoryId: primaryMemoryId,
      memoryIds: updatedIds,
      memory: updated ?? null,
    },
  };
}

async function doDelete(
  runtime: IAgentRuntime,
  message: Memory,
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
  return doDeleteByQuery(runtime, message, params, query);
}

/**
 * Delete-by-query: "remove that fact" carries no memoryId, so resolve the
 * memory through the same cluster-expanded read scope search uses, then
 * delete. Reflection dedup failures leave several rows with identical text —
 * one logical fact — so all rows of the single matched text are removed.
 * A query that strongly matches more than one distinct text is ambiguous:
 * refuse and list the candidates so the model can delete by exact id.
 *
 * The read is pinned to the requesting entity's identity cluster: a text-only
 * match in a multi-user room would also hit another user's identical-text
 * fact, so "forget that I play guitar" may only remove the asking user's own
 * rows. Cross-entity deletes must go through op:search + delete by memoryId.
 */
async function doDeleteByQuery(
  runtime: IAgentRuntime,
  message: Memory,
  params: MemoryParams,
  query: string,
): Promise<ActionResult> {
  const type =
    params.type && MEMORY_TYPES.includes(params.type) ? params.type : undefined;
  const entityParam = parseUuidParam(params.entityId, "entityId");
  if (!entityParam.ok) return entityParam.result;
  const roomParam = parseUuidParam(params.roomId, "roomId");
  if (!roomParam.ok) return roomParam.result;

  // Requester wins over a model-supplied entityId: model ids arrive as free
  // text and could name another user, reopening the cross-user match this
  // scope exists to close. The parsed param is a fallback only for messages
  // that carry no entity (internal maintenance invocations).
  const scopeEntityId = message.entityId ?? entityParam.id;

  const scan = await collectCandidates(runtime, {
    type,
    entityId: scopeEntityId,
    roomId: roomParam.id,
    query,
  });

  // Deletion needs a stronger bar than search ranking: scoreText >= 1 means
  // the whole phrase matched or every query term matched.
  const matched = scan.matches.filter((c) => {
    const text =
      (c.memory.content as { text?: string } | undefined)?.text ?? "";
    return scoreText(text, query) >= 1;
  });

  if (matched.length === 0) {
    return fail(
      `No stored memory matches "${query}". ${describeCompleteScan(scan)}`,
      "MEMORY_NOT_FOUND",
    );
  }

  const normalize = (c: MemoryCandidate) =>
    ((c.memory.content as { text?: string } | undefined)?.text ?? "")
      .trim()
      .toLowerCase();
  const distinctTexts = new Set(matched.map(normalize));
  if (distinctTexts.size > 1) {
    const lines = matched
      .map((c) => toListItem(c.memory, c.type))
      .map((m) => `- [${m.type}] ${m.id}: ${toWellFormedUnicode(m.text)}`);
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
    text: `Forgot ${deleted.length} memory record(s) matching "${query}": ${toWellFormedUnicode(deleted[0]?.text ?? "")}`,
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
    // Stage-1 recall names bind directly to the MEMORY umbrella action.
    "RECALL_MEMORY",
    "RECALL_MEMORIES",
    "MEMORY_RECALL",
    "MEMORY_SEARCH",
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
    "Manage agent memory records. op:create stores a new memory; op:search filters by type/entityId/roomId/query; op:update edits by memoryId or a unique requester-scoped query match (requires confirm:true); op:delete removes by memoryId or requester-scoped query match (requires confirm:true).",
  descriptionCompressed:
    "manage agent memory create search update delete; update/delete by memoryId or query; update/delete require confirm:true",
  routingHint:
    "NOTES ARE NOT MEMORY: 'make a note', 'note to self', 'jot this down', 'what notes do i have' -> the NOTES action, which writes the durable note store the user sees in the Notes view. MEMORY is the agent's own recall of the conversation. store/search/edit the agent's OWN memory records about the user or conversation -> MEMORY. This includes recalling or COUNTING what was said earlier than the messages shown in context ('how many times have I mentioned X', 'have I ever told you about X', 'what did we say about X last week') — the conversation block in context is only the most recent turns, so answer those from op:search over the stored record, never from that block alone. Do NOT use for open-web lookups -> WEB_SEARCH, for searching connected external channels such as email or another platform's inbox -> MESSAGE (action=search), or for the skill catalog -> SKILL",
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
          return await doUpdate(runtime, message, params);
        case "delete":
          return await doDelete(runtime, message, params);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[memory:${op}] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to ${op} memory: ${msg}`,
        data: {
          error:
            err instanceof ElizaError
              ? err.code
              : `MEMORY_${op.toUpperCase()}_FAILED`,
        },
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
    // entityId/roomId carry no schema `pattern` on purpose (matrix F16): a
    // planner-copied UUID arrives mangled often enough (live: a dropped hex
    // char in the roomId first segment, tj-b0c123243cb39e) that the
    // validate-tool-args pattern check failed the whole call before the
    // handler could apply its per-op policy — search salvages by ignoring the
    // unusable filter, destructive ops still hard-fail via parseUuidParam.
    {
      name: "entityId",
      description:
        "search: optional entity UUID from a previous result. Omit it when no exact UUID is known.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description:
        'search: optional room UUID from a previous result. Omit it to search all stored rooms; never pass a source label such as "chat".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "search/update/delete: case-insensitive text match against memory content. update/delete: resolves the memory to mutate when memoryId is unknown; scoped to the requesting user's own memories.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: `search: optional positive page size up to ${MAX_MEMORY_PAGE_ITEMS}. Large complete results reject with a typed instruction to retry using this lossless pagination contract.`,
      required: false,
      schema: {
        type: "integer" as const,
        minimum: 1,
        maximum: MAX_MEMORY_PAGE_ITEMS,
      },
    },
    {
      name: "offset",
      description:
        "search: zero-based continuation offset from a previous paginated result. Requires the same filters and limit.",
      required: false,
      schema: { type: "integer" as const, minimum: 0 },
    },
    {
      name: "snapshot",
      description:
        "search: continuation fingerprint returned by the previous page. Required with a positive offset so changed results reject instead of shifting pages.",
      required: false,
      schema: { type: "string" as const, pattern: "^[0-9a-f]{64}$" },
    },
    {
      name: "memoryId",
      description:
        "update/delete: id of the memory to mutate; optional when query is provided.",
      required: false,
      modelOmissionSentinels: ["", "null", "undefined"],
      schema: { type: "string" as const, pattern: UUID_SCHEMA_PATTERN },
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
        content: {
          text: "Showing all N match(es) found in the complete scan...",
          action: "MEMORY",
        },
      },
    ],
  ],
};
