/**
 * MEMORY action: model-driven create/search/update/delete over the agent's
 * stored memories. Reads MUST match the scope the FACTS provider uses —
 * identity-cluster-expanded entity ids — or a fact the provider surfaces
 * reads back as "0 stored items" here, and deletion becomes unreachable.
 * All model-supplied ids are parsed before touching the database so a bad
 * id becomes a clean handled result, never a raw SQL error in model context.
 */
import type {
  AccessContext,
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  buildAccessContext,
  MemoryType as CoreMemoryType,
  getRelatedEntityIds,
  logger,
  ModelType,
  markOwnerExclusiveDisclosureUsed,
  OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS,
  recordOwnerExclusiveSuppression,
  revalidateOwnerExclusiveDisclosure,
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
  memoryId?: string;
  confirm?: boolean;
  /** search: 1-based caller-selected page of the cross-room history digest. */
  page?: number;
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
 * A candidate set plus the shape of the window it was read from. The read is
 * always windowed — `perTable` most-recent rows per memory table — and the
 * query/entity filters run in memory over that window, so the surviving count
 * is a count of matches INSIDE the window and never a total.
 *
 * Saturation is MEASURED by reading one row past the window: a table holding
 * exactly `perTable` rows fills it without hiding anything, and is
 * indistinguishable from a truncated one by row count alone. Treating a merely
 * full page as saturated tells the reader older rows went unscanned when none
 * exist — a fabricated scope claim in the sentence meant to prevent them.
 */
interface CandidateScan {
  matches: MemoryCandidate[];
  perTable: number;
  tables: readonly MemoryType[];
  saturatedTables: MemoryType[];
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
    limit: number;
  },
): Promise<CandidateScan> {
  const tables: readonly MemoryType[] = scope.type
    ? [scope.type]
    : MEMORY_TYPES;
  const perTable = Math.max(scope.limit * 2, 200);
  const collected: MemoryCandidate[] = [];
  const saturatedTables: MemoryType[] = [];

  for (const tableName of tables) {
    // One row past the window, so "older rows exist" is observed rather than
    // assumed from a page that happened to fill.
    const page = await runtime.getMemories({
      agentId: runtime.agentId as UUID,
      roomId: scope.roomId,
      tableName,
      limit: perTable + 1,
    });
    const overflowed = page.length > perTable;
    if (overflowed) saturatedTables.push(tableName);
    const memories = overflowed ? page.slice(0, perTable) : page;
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
  return { matches: filtered, perTable, tables, saturatedTables };
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

/**
 * The sentence that keeps a windowed count from being read as a total. The
 * scan reads only the most recent `perTable` rows per table, so "0 matches"
 * means "no match in the window", not "nothing is stored" — the difference
 * between answering "what do you remember about my sister" with a fact and
 * with "I have nothing stored about her".
 */
function describeScanWindow(scan: CandidateScan): string {
  const base = `Scanned only the ${scan.perTable} most recent row(s) of each table (${scan.tables.join(", ")}) before filtering.`;
  if (scan.saturatedTables.length === 0) {
    // "overflowed", not "filled": a table holding exactly `perTable` rows fills
    // the window and still had every row considered. Only overflow hides rows.
    return `${base} No table overflowed that window, so every stored row in the scanned tables was considered.`;
  }
  return `${base} ${scan.saturatedTables.join(", ")} filled that window, so older rows were NOT scanned and this is a windowed match count, not a total — widen with type, entityId, roomId, or a higher limit (the window is max(limit*2, 200) rows per table).`;
}

/**
 * Enumeration-style history questions ("what have we talked about lately",
 * "look at the recent logs") are NOT keyword lookups: BM25/keyword scoring
 * against phrases like "recent logs" matches rows that literally contain
 * "recent" or "logs" and misses everything the user actually means (live
 * 2026-08-22: days of history sat in the messages table while op:search
 * returned only literal matches, so the reply enumerated a fraction of the
 * week). These patterns request a TIME SLICE, so serve them a chronological
 * cross-room digest of the last few days.
 *
 * The classifier requires a history/conversation context word: bare temporal
 * adverbs ("lately") fire on unrelated sentences ("the tests have been flaky
 * lately"), so "lately" only classifies when the query also names talking,
 * chatting, messages, logs, or history.
 */
const RECENT_HISTORY_PATTERNS = [
  /\b(?:recent|latest)\b.*\b(?:logs?|journals?|chats?|conversations?|messages?|days?|history)\b/i,
  /\b(?:last|past)\s+(?:few|couple(?:\s+of)?|\d+)?\s*(?:days?|nights?|weeks?)\b/i,
  /\bwhat\s+(?:have|did)\s+we\s+(?:talk|chat|discuss|cover)\b/i,
  /\b(?:catch|fill)\s+me\s+up\b/i,
  /\b(?:this|the)\s+week'?s?\b.*\b(?:conversations?|chats?|topics?|logs?)\b/i,
];
const HISTORY_CONTEXT_PATTERN =
  /\b(?:talk(?:ed|ing)?|chat(?:s|ted|ting)?|discuss(?:ed|ion|ions)?|conversations?|messages?|logs?|history|said|covered|catch(?:ing)?\s+up)\b/i;

function isRecentHistoryQuery(query: string): boolean {
  if (RECENT_HISTORY_PATTERNS.some((p) => p.test(query))) return true;
  return /\blately\b/i.test(query) && HISTORY_CONTEXT_PATTERN.test(query);
}

const HISTORY_DIGEST_DAYS = 7;
/** Store page size for the internal complete traversal. */
const HISTORY_TRAVERSAL_PAGE_ROWS = 500;
/** Traversal budget. Hitting it returns typed-incomplete, never a partial. */
const HISTORY_TRAVERSAL_MAX_ROWS = 20_000;
/** Caller-visible digest page size (complete lines per op:search call). */
const HISTORY_DIGEST_PAGE_LINES = 150;
/**
 * Double-persist twins are the same platform message written twice ~250ms
 * apart. Identical text from the same speaker OUTSIDE this window is a real
 * repeat (someone genuinely said it again) and must render.
 */
const HISTORY_TWIN_WINDOW_MS = 2_000;
/** Ingestion wrapper: '[Discord #chan | guild] @user (date): text' */
const CONNECTOR_PREFIX_PATTERN =
  /^\[[^\]\n]{1,120}\]\s+@\S+\s+\([^)]{1,60}\):\s*/;

type HistoryDigestOutcome =
  | {
      status: "rendered";
      text: string;
      totalLines: number;
      renderedLines: number;
      page: number;
      pageCount: number;
      traversedRows: number;
      roomCount: number;
    }
  /** The digest lane does not apply (gate denied or wrong disclosure basis). */
  | { status: "not_applicable" }
  /**
   * The digest applies but could not be produced completely. The caller must
   * surface this as a typed failure — never fall back to a healthy-looking
   * keyword result, and never emit a partial digest.
   */
  | {
      status: "unavailable";
      code:
        | "MEMORY_HISTORY_DIGEST_INCOMPLETE"
        | "MEMORY_HISTORY_DIGEST_UNAVAILABLE";
      detail: string;
    };

interface HistoryTraversalOutcome {
  rows?: Memory[];
  traversedRows?: number;
  failure?: HistoryDigestOutcome & { status: "unavailable" };
}

/**
 * Complete traversal of the interval's authorized rows via advancing
 * limit/offset pages over `getMemoriesByRoomIds` (store contract: createdAt
 * DESC). Completeness is guaranteed by construction, not by a cap:
 * - a short or empty page means the scoped set is exhausted;
 * - a full page whose oldest row predates the cutoff means every remaining
 *   row is older than the interval (ordering is verified, below), so the
 *   interval is fully collected;
 * - otherwise the offset advances and the next page is read.
 * Instability is detected instead of silently tolerated: a page that repeats
 * the previous page, contributes zero unseen rows, violates DESC ordering
 * internally, or is newer than the previous page boundary means the
 * underlying set shifted mid-traversal — the traversal returns
 * typed-incomplete rather than emitting rows it cannot prove complete.
 */
async function traverseHistoryRows(
  runtime: IAgentRuntime,
  roomIds: UUID[],
  accessContext: AccessContext,
  cutoff: number,
  message: Memory,
): Promise<HistoryTraversalOutcome> {
  const seenIds = new Set<string>();
  const collected: Memory[] = [];
  let offset = 0;
  let prevBoundaryOldest = Number.POSITIVE_INFINITY;
  let prevPageSignature = "";

  while (true) {
    if (offset >= HISTORY_TRAVERSAL_MAX_ROWS) {
      return {
        failure: {
          status: "unavailable",
          code: "MEMORY_HISTORY_DIGEST_INCOMPLETE",
          detail: `the interval spans more than ${HISTORY_TRAVERSAL_MAX_ROWS} stored rows; narrow the time window or use a keyword query`,
        },
      };
    }

    let page: Memory[];
    try {
      page = await runtime.getMemoriesByRoomIds({
        tableName: "messages",
        roomIds,
        limit: HISTORY_TRAVERSAL_PAGE_ROWS,
        offset,
        accessContext,
      });
    } catch (error) {
      // error-policy: a storage failure must surface as a typed unavailable
      // outcome, not degrade into a healthy keyword result.
      runtime.reportError("MemoryAction.recentHistoryDigest.read", error, {
        roomCount: roomIds.length,
        offset,
        roomId: message.roomId,
        entityId: message.entityId,
      });
      return {
        failure: {
          status: "unavailable",
          code: "MEMORY_HISTORY_DIGEST_UNAVAILABLE",
          detail: "the message store read failed",
        },
      };
    }

    if (page.length === 0) break;

    const signature = page
      .map((m) => m.id ?? `${m.roomId}:${m.entityId}:${m.createdAt}`)
      .join("|");
    let orderedDesc = true;
    for (let i = 1; i < page.length; i += 1) {
      if ((page[i]?.createdAt ?? 0) > (page[i - 1]?.createdAt ?? 0)) {
        orderedDesc = false;
        break;
      }
    }
    const newestInPage = page.reduce(
      (max, m) => Math.max(max, m.createdAt ?? 0),
      0,
    );
    let newRows = 0;
    for (const m of page) {
      const key = m.id ?? `${m.roomId}:${m.entityId}:${m.createdAt}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        newRows += 1;
      }
    }

    if (
      signature === prevPageSignature ||
      newRows === 0 ||
      !orderedDesc ||
      newestInPage > prevBoundaryOldest
    ) {
      const reason =
        signature === prevPageSignature || newRows === 0
          ? "pagination did not advance (stalled page)"
          : "page ordering changed mid-traversal";
      runtime.reportError(
        "MemoryAction.recentHistoryDigest.traversal",
        new Error(`history traversal instability: ${reason}`),
        {
          roomCount: roomIds.length,
          offset,
          roomId: message.roomId,
          entityId: message.entityId,
        },
      );
      return {
        failure: {
          status: "unavailable",
          code: "MEMORY_HISTORY_DIGEST_INCOMPLETE",
          detail: `the store returned unstable pages (${reason}); the interval could not be traversed completely`,
        },
      };
    }

    prevPageSignature = signature;
    const oldestInPage = page.reduce(
      (min, m) => Math.min(min, m.createdAt ?? 0),
      Number.POSITIVE_INFINITY,
    );
    prevBoundaryOldest = oldestInPage;

    for (const m of page) {
      const text = (m.content as { text?: string } | undefined)?.text;
      if (typeof text !== "string" || !text.trim()) continue;
      if ((m.createdAt ?? 0) < cutoff) continue;
      collected.push(m);
    }

    // Ordering is DESC and verified: a full page whose oldest row predates
    // the cutoff proves every unread row is older than the interval.
    if (oldestInPage < cutoff) break;
    if (page.length < HISTORY_TRAVERSAL_PAGE_ROWS) break;
    offset += page.length;
  }

  return { rows: collected, traversedRows: seenIds.size };
}

/**
 * Chronological digest of the sender's rooms over the last week. Owner-private
 * gated: this is deliberately cross-room recall, so it renders ONLY when the
 * live delivery audience is a verified owner-only destination — an owner DM,
 * private voice room, or authenticated owner api_private room whose entire
 * 2-member census is exactly {owner, agent}. The gate DENIES every
 * group/channel kind. On deny the search keeps its room-scoped keyword scan
 * (with the suppression recorded), so other participants never see
 * private-room content.
 *
 * Output contract (no silent partials):
 * - Complete row text. No per-line truncation; only the ingestion connector
 *   wrapper (which duplicates the stamp/speaker the line already carries) is
 *   stripped.
 * - Complete traversal of the interval before any rendering; if the interval
 *   cannot be traversed completely and stably, the outcome is a typed
 *   incomplete/unavailable result and NO digest text is produced.
 * - When the digest exceeds one page of lines, paging is explicit and
 *   caller-selected via the `page` parameter: lines are ordered ascending by
 *   (createdAt, id) so earlier pages stay stable as new messages arrive, and
 *   the footer names the exact remaining line count and the next page number.
 * - Dedupe removes only the double-persist twin (same platform message row
 *   written twice ~250ms apart): rows sharing a platformMessageId render
 *   once, and text-keyed dedupe uses the FULL normalized text within a 2s
 *   window — distinct messages that share a long prefix, and genuine repeats
 *   minutes apart, all render.
 */
async function buildRecentHistoryDigest(
  runtime: IAgentRuntime,
  message: Memory,
  requestedPage: number | undefined,
): Promise<HistoryDigestOutcome> {
  let disclosure: Awaited<
    ReturnType<typeof revalidateOwnerExclusiveDisclosure>
  >;
  try {
    disclosure = await revalidateOwnerExclusiveDisclosure(runtime, message);
  } catch (error) {
    // error-policy: a gate evaluation failure is not a deny and not a healthy
    // keyword search — it is a typed unavailable outcome.
    runtime.reportError("MemoryAction.recentHistoryDigest.gate", error, {
      roomId: message.roomId,
      entityId: message.entityId,
    });
    return {
      status: "unavailable",
      code: "MEMORY_HISTORY_DIGEST_UNAVAILABLE",
      detail: "the owner-private disclosure gate could not be evaluated",
    };
  }
  if (
    !disclosure.allowed ||
    disclosure.basis !== OWNER_PRIVATE_DESTINATION_DISCLOSURE_BASIS
  ) {
    // Suppression is recorded only on a real deny. An allowed-but-wrong-basis
    // decision (internal_agent_turn) is not a suppressed owner surface — the
    // lane simply does not apply to that audience.
    if (!disclosure.allowed) {
      recordOwnerExclusiveSuppression(message, disclosure.reason);
    }
    return { status: "not_applicable" };
  }

  const cutoff = Date.now() - HISTORY_DIGEST_DAYS * 24 * 60 * 60 * 1000;
  let accessContext: AccessContext;
  let roomIds: UUID[];
  try {
    // The access context scopes the store read to what the requester may see;
    // per the database contract, omitting it disables access-context filtering
    // entirely, which would leak access-restricted rows into the digest.
    accessContext = await buildAccessContext(runtime, message);
    const clusterIds = await getRelatedEntityIds(runtime, message.entityId);
    const roomIdSets = await Promise.all(
      clusterIds.map((id) => runtime.getRoomsForParticipant(id)),
    );
    roomIds = [...new Set(roomIdSets.flat())];
  } catch (error) {
    runtime.reportError("MemoryAction.recentHistoryDigest.scope", error, {
      roomId: message.roomId,
      entityId: message.entityId,
    });
    return {
      status: "unavailable",
      code: "MEMORY_HISTORY_DIGEST_UNAVAILABLE",
      detail: "the sender's room scope could not be resolved",
    };
  }

  const header = (roomCount: number, totalLines: number): string =>
    `Chronological conversation digest, last ${HISTORY_DIGEST_DAYS} days across ${roomCount} room(s), complete traversal of the interval (${totalLines} line(s) after twin dedupe; owner-private destination verified):`;

  if (roomIds.length === 0) {
    return {
      status: "rendered",
      text: [
        header(0, 0),
        `No conversation rooms are associated with this sender, so there are no messages in the last ${HISTORY_DIGEST_DAYS} days.`,
      ].join("\n"),
      totalLines: 0,
      renderedLines: 0,
      page: 1,
      pageCount: 1,
      traversedRows: 0,
      roomCount: 0,
    };
  }

  const traversal = await traverseHistoryRows(
    runtime,
    roomIds,
    accessContext,
    cutoff,
    message,
  );
  if (traversal.failure) return traversal.failure;
  const rows = traversal.rows ?? [];

  rows.sort((a, b) => {
    const at = a.createdAt ?? 0;
    const bt = b.createdAt ?? 0;
    if (at !== bt) return at - bt;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  const agentName = runtime.character.name ?? "Agent";
  const lastSeenAt = new Map<string, number>();
  const lines: string[] = [];
  for (const m of rows) {
    const raw = ((m.content as { text?: string }).text ?? "").trim();
    const text = raw.replace(CONNECTOR_PREFIX_PATTERN, "").replace(/\s+/g, " ");
    const createdAt = m.createdAt ?? 0;
    const platformMessageId = (
      m.metadata as { platformMessageId?: string } | undefined
    )?.platformMessageId;
    // Twin dedupe on a stable identity when one exists; otherwise on the FULL
    // normalized text inside a tight window. Never on a sliced prefix —
    // distinct messages sharing a long prefix must both render.
    const key = platformMessageId
      ? `pmid:${m.roomId}:${platformMessageId}`
      : `txt:${m.roomId}:${m.entityId}:${text}`;
    const prev = lastSeenAt.get(key);
    if (
      prev !== undefined &&
      (platformMessageId || createdAt - prev <= HISTORY_TWIN_WINDOW_MS)
    ) {
      lastSeenAt.set(key, createdAt);
      continue;
    }
    lastSeenAt.set(key, createdAt);
    const when = new Date(createdAt);
    const stamp = `${String(when.getUTCMonth() + 1).padStart(2, "0")}/${String(
      when.getUTCDate(),
    ).padStart(2, "0")} ${String(when.getUTCHours()).padStart(2, "0")}:${String(
      when.getUTCMinutes(),
    ).padStart(2, "0")}Z`;
    const speaker = m.entityId === runtime.agentId ? agentName : "user";
    lines.push(`[${stamp}] ${speaker}: ${text}`);
  }

  const totalLines = lines.length;
  if (totalLines === 0) {
    return {
      status: "rendered",
      text: [
        header(roomIds.length, 0),
        `No messages in the last ${HISTORY_DIGEST_DAYS} days.`,
      ].join("\n"),
      totalLines: 0,
      renderedLines: 0,
      page: 1,
      pageCount: 1,
      traversedRows: traversal.traversedRows ?? 0,
      roomCount: roomIds.length,
    };
  }

  const pageCount = Math.max(
    1,
    Math.ceil(totalLines / HISTORY_DIGEST_PAGE_LINES),
  );
  const requested = Math.max(1, Math.floor(requestedPage ?? 1));
  const page = Math.min(requested, pageCount);
  const start = (page - 1) * HISTORY_DIGEST_PAGE_LINES;
  const shown = lines.slice(start, start + HISTORY_DIGEST_PAGE_LINES);
  const end = start + shown.length;

  const notes: string[] = [];
  if (requested !== page) {
    notes.push(
      `Requested page ${requested} exceeds the ${pageCount} available page(s); showing page ${pageCount}.`,
    );
  }
  let footer: string;
  if (pageCount === 1) {
    footer = `Digest complete: all ${totalLines} line(s) shown.`;
  } else if (page < pageCount) {
    footer = `Digest page ${page} of ${pageCount}: lines ${start + 1}-${end} of ${totalLines}. ${totalLines - end} later line(s) are NOT shown on this page; request op:search with the same query and page:${page + 1} to continue.`;
  } else {
    footer = `Digest page ${page} of ${pageCount}: lines ${start + 1}-${end} of ${totalLines}. Earlier lines are on pages 1-${pageCount - 1}.`;
  }

  return {
    status: "rendered",
    text: [header(roomIds.length, totalLines), ...notes, ...shown, footer].join(
      "\n",
    ),
    totalLines,
    renderedLines: shown.length,
    page,
    pageCount,
    traversedRows: traversal.traversedRows ?? 0,
    roomCount: roomIds.length,
  };
}

async function doSearch(
  runtime: IAgentRuntime,
  message: Memory,
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
  const limit = clampLimit(params.limit, 50);

  const scope = {
    type,
    entityId: entityParam.ok ? entityParam.id : undefined,
    roomId: roomParam.ok ? roomParam.id : undefined,
    query,
  };
  const scan = await collectCandidates(runtime, { ...scope, limit });

  // Enumeration lane: "what have we talked about lately" is a time-slice
  // request, not a keyword lookup. When the pattern matches AND the delivery
  // audience is verified owner-private, a complete chronological digest leads
  // the result. A digest FAILURE is a typed unavailable outcome for the whole
  // search — the keyword scan alone would silently answer a question it
  // cannot answer, presenting a broken pipeline as a healthy-but-thin result.
  let digest: (HistoryDigestOutcome & { status: "rendered" }) | null = null;
  if (query && isRecentHistoryQuery(query)) {
    const outcome = await buildRecentHistoryDigest(
      runtime,
      message,
      params.page,
    );
    if (outcome.status === "unavailable") {
      return {
        success: false,
        text: `The cross-room history digest for this time-slice query is unavailable: ${outcome.detail}. No partial digest was emitted. Retry, or scope the request to a room with a keyword query.`,
        data: {
          actionName: "MEMORY",
          op: "search" as const,
          error: outcome.code,
          detail: outcome.detail,
        },
      };
    }
    if (outcome.status === "rendered") {
      // The digest discloses cross-room owner-private content: arm the egress
      // re-validation / stream-suppression seams keyed on
      // ownerExclusiveDisclosureWasUsed.
      markOwnerExclusiveDisclosureUsed(message);
      digest = outcome;
    }
  }

  const matchedInWindow = scan.matches.length;
  const items = scan.matches
    .slice(0, limit)
    .map((c) => toListItem(c.memory, c.type));
  // The text projection carries enough of each hit for model reasoning; the
  // complete records remain machine data for state and trajectory consumers.
  const lines = items.map(
    (m) => `- [${m.type}] ${m.id}: ${toWellFormedUnicode(m.text)}`,
  );
  const userFacingText = items.length
    ? [
        `I found ${items.length} matching memory record(s):`,
        ...items.map(
          (item) => `- [${item.type}] ${toWellFormedUnicode(item.text)}`,
        ),
      ].join("\n")
    : undefined;

  // Report what was actually rendered, not what was collected: the previous
  // header claimed up to 50 items while printing 25 lines, and printed the
  // in-window match count under the label "total".
  const renderNote =
    lines.length < matchedInWindow
      ? `Showing ${lines.length} of ${matchedInWindow} match(es) in the scanned window`
      : `Showing all ${lines.length} match(es) found in the scanned window`;

  return {
    success: true,
    text: [
      // The digest leads: for an enumeration question it IS the answer, and
      // the keyword matches below it are supporting detail.
      ...(digest ? [digest.text, ""] : []),
      `${renderNote} (filters: ${describeSearchScope(scope)}).`,
      ...(ignoredIdNotes.length > 0
        ? [`Note: ${ignoredIdNotes.join("; ")}.`]
        : []),
      describeScanWindow(scan),
      ...lines,
    ].join("\n"),
    ...(userFacingText && recallTerminalEnabled(runtime)
      ? {
          userFacingText,
          verifiedUserFacing: true,
          turnComplete: true,
        }
      : {}),
    values: {
      count: items.length,
      rendered: lines.length,
      matchedInWindow,
      scanWindowPerTable: scan.perTable,
      scanWindowSaturated: scan.saturatedTables.length > 0,
      historyDigestIncluded: digest !== null,
      ...(digest
        ? {
            historyDigestTotalLines: digest.totalLines,
            historyDigestRenderedLines: digest.renderedLines,
            historyDigestPage: digest.page,
            historyDigestPageCount: digest.pageCount,
            historyDigestTraversedRows: digest.traversedRows,
            historyDigestRoomCount: digest.roomCount,
          }
        : {}),
    },
    data: {
      actionName: "MEMORY",
      op: "search" as const,
      memories: items,
      matchedInWindow,
      scanWindowPerTable: scan.perTable,
      scanWindowSaturatedTables: scan.saturatedTables,
      limit,
    },
    promptData: {
      actionName: "MEMORY",
      op: "search" as const,
      matchedInWindow,
      rendered: lines.length,
      scanWindowPerTable: scan.perTable,
      scanWindowSaturatedTables: scan.saturatedTables,
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

  const limit = clampLimit(params.limit, 50);
  const scan = await collectCandidates(runtime, {
    type,
    entityId: scopeEntityId,
    roomId: roomParam.id,
    query,
    limit,
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
      `No stored memory matches "${query}". ${describeScanWindow(scan)}`,
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
    "Manage agent memory records. op:create stores a new memory; op:search filters by type/entityId/roomId/query; op:update edits text and re-embeds (requires confirm:true); op:delete removes a memory by memoryId or by query text match (requires confirm:true).",
  descriptionCompressed:
    "manage agent memory create search update delete; delete by memoryId or query; update/delete require confirm:true",
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
          return await doSearch(runtime, message, params);
        case "update":
          return await doUpdate(runtime, params);
        case "delete":
          return await doDelete(runtime, message, params);
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
        "search/delete: case-insensitive text match against memory content. delete: resolves the memory to remove when memoryId is unknown; scoped to the requesting user's own memories.",
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
      name: "page",
      description:
        "search: 1-based page of the cross-room history digest for time-slice queries. Each page renders complete lines; when more remain, the digest footer names the next page to request.",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "memoryId",
      description:
        "update/delete: id of the memory to mutate. delete: optional when query is provided.",
      required: false,
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
          text: "Showing N of M match(es) in the scanned window...",
          action: "MEMORY",
        },
      },
    ],
  ],
};
