/**
 * Tenant-scoped CQRS access to `shared_agent_memories`, the durable core-shape
 * memory rows written by container-free Shared runtimes. The writer owns
 * idempotent inserts and monotonic message convergence; the reader owns
 * room-recency listing and embedding search. Every SQL predicate pins
 * `organization_id` AND `user_id` — no row is reachable through this module
 * from outside its owning tenant.
 *
 * Embedding search tradeoff: the column is `real[]` (mirroring the core
 * memories row), so there is no ANN index; `searchByEmbedding` runs exact
 * pgvector cosine distance (`::vector <=> ::vector`, extension created in
 * migration 0000) over a bounded most-recent window of one trusted room's rows.
 * Cost is therefore O(window) per query regardless of table size, and rows
 * older than the window are invisible to semantic recall by design.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, inArray, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import { type SharedAgentMemoryRow, sharedAgentMemories } from "../schemas/shared-agent-memories";
import { jsonbParam } from "../utils/jsonb";

export const SHARED_AGENT_MEMORY_INVALID_INPUT = "SHARED_AGENT_MEMORY_INVALID_INPUT";
export const SHARED_AGENT_MEMORY_ID_CONFLICT = "SHARED_AGENT_MEMORY_ID_CONFLICT";

/** Rows semantically scanned per embedding search (see module header). */
export const SHARED_AGENT_MEMORY_SEARCH_WINDOW = 512;
const MAX_LIST_LIMIT = 200;
const MAX_LIST_OFFSET = 100_000;
const MAX_EMBEDDING_DIMENSIONS = 4096;

/** Tenant ownership + storage agent identity required on every call. */
export interface SharedAgentMemoryScope {
  organizationId: string;
  userId: string;
  agentId: string;
}

export interface InsertSharedAgentMemoryInput {
  /** Stable row id for replay-idempotent writes; omitted ids are generated. */
  id?: string;
  scope: SharedAgentMemoryScope;
  entityId?: string | null;
  roomId?: string | null;
  worldId?: string | null;
  /** Core table-name discriminator, e.g. "messages". */
  type: string;
  content: Record<string, unknown>;
  embedding?: number[] | null;
  embeddingModel?: string | null;
  createdAt?: Date;
}

export interface InsertSharedAgentMemoryResult {
  id: string;
  /** False when the same id already existed inside this tenant (a replay). */
  inserted: boolean;
}

export interface ListSharedAgentMemoriesInput {
  type?: string;
  entityIds?: string[];
  roomId?: string;
  /** Canonical browse semantics: whole query OR any query term of 2+ chars. */
  textQuery?: string;
  limit: number;
  offset?: number;
  before?: Date;
  beforeId?: string;
}

export type CountSharedAgentMemoriesInput = Pick<
  ListSharedAgentMemoriesInput,
  "type" | "entityIds" | "roomId" | "textQuery"
>;

export interface ListSharedAgentMemoriesResult {
  rows: SharedAgentMemoryRow[];
  hasMore: boolean;
}

export interface SharedAgentMemoryTypeCount {
  type: string;
  count: number;
}

export interface MergeSharedAgentMessageMemoryInput
  extends Omit<InsertSharedAgentMemoryInput, "id"> {
  /** Stable transport id shared by interrupted attempts and their retry. */
  id: string;
  /** Whether this row contains only the client-visible interrupted prefix. */
  interrupted: boolean;
}

export type SharedAgentMemorySearchHit = SharedAgentMemoryRow & { distance: number };

function requiredScope(scope: SharedAgentMemoryScope): SharedAgentMemoryScope {
  for (const [field, value] of Object.entries(scope)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ElizaError("Shared agent memory scope is incomplete", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field },
      });
    }
  }
  return scope;
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new ElizaError("Shared agent memory limit must be a positive integer within bounds", {
      code: SHARED_AGENT_MEMORY_INVALID_INPUT,
      context: { limit, max: MAX_LIST_LIMIT },
    });
  }
}

function assertEmbedding(embedding: number[]): void {
  if (
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    embedding.length > MAX_EMBEDDING_DIMENSIONS ||
    embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new ElizaError("Shared agent memory embedding must be a bounded finite vector", {
      code: SHARED_AGENT_MEMORY_INVALID_INPUT,
      context: { dimensions: Array.isArray(embedding) ? embedding.length : null },
    });
  }
}

/** pgvector literal for a validated query vector, bound as one text param. */
function vectorParam(embedding: number[]) {
  return sql`${`[${embedding.join(",")}]`}::vector`;
}

function tenantPins(scope: SharedAgentMemoryScope) {
  return [
    eq(sharedAgentMemories.organization_id, scope.organizationId),
    eq(sharedAgentMemories.user_id, scope.userId),
    eq(sharedAgentMemories.agent_id, scope.agentId),
  ] as const;
}

function memoryTextQueryPredicate(query: string): SQL | undefined {
  const normalized = query.trim();
  if (!normalized) return undefined;
  const candidates = [
    normalized,
    ...normalized.split(/\s+/).filter((term) => term.length >= 2),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
  return or(
    ...candidates.map(
      (candidate) =>
        sql<boolean>`strpos(lower(COALESCE(${sharedAgentMemories.content}->>'text', '')), lower(${candidate})) > 0`,
    ),
  );
}

function productListPredicates(
  scope: SharedAgentMemoryScope,
  input: CountSharedAgentMemoriesInput,
): SQL[] {
  const predicates: SQL[] = [...tenantPins(requiredScope(scope))];
  if (input.type) {
    predicates.push(eq(sharedAgentMemories.type, input.type));
  }
  if (input.entityIds?.length) {
    predicates.push(inArray(sharedAgentMemories.entity_id, input.entityIds));
  }
  if (input.roomId) {
    predicates.push(eq(sharedAgentMemories.room_id, input.roomId));
  }
  if (input.textQuery) {
    const textPredicate = memoryTextQueryPredicate(input.textQuery);
    if (textPredicate) predicates.push(textPredicate);
  }
  return predicates;
}

export class SharedAgentMemoriesWriter {
  /**
   * Insert one memory row. A same-id row already owned by the SAME tenant is a
   * transport replay and reports `inserted: false`; a same-id row outside the
   * tenant is an integrity violation and throws instead of silently no-oping.
   */
  async insertMemory(input: InsertSharedAgentMemoryInput): Promise<InsertSharedAgentMemoryResult> {
    const scope = requiredScope(input.scope);
    if (typeof input.type !== "string" || input.type.trim().length === 0) {
      throw new ElizaError("Shared agent memory type is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "type" },
      });
    }
    if (input.embedding != null) assertEmbedding(input.embedding);
    const inserted = await dbWrite
      .insert(sharedAgentMemories)
      .values({
        ...(input.id ? { id: input.id } : {}),
        organization_id: scope.organizationId,
        user_id: scope.userId,
        agent_id: scope.agentId,
        entity_id: input.entityId ?? null,
        room_id: input.roomId ?? null,
        world_id: input.worldId ?? null,
        type: input.type,
        content: jsonbParam(input.content),
        embedding: input.embedding ?? null,
        embedding_model: input.embeddingModel ?? null,
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      })
      .onConflictDoNothing({ target: [sharedAgentMemories.id] })
      .returning({ id: sharedAgentMemories.id });
    const row = inserted.at(0);
    if (row) return { id: row.id, inserted: true };
    if (!input.id) {
      throw new ElizaError("Shared agent memory insert returned no row", {
        code: SHARED_AGENT_MEMORY_ID_CONFLICT,
        context: { organizationId: scope.organizationId },
      });
    }
    const [existing] = await dbRead
      .select({ id: sharedAgentMemories.id })
      .from(sharedAgentMemories)
      .where(and(...tenantPins(scope), eq(sharedAgentMemories.id, input.id)))
      .limit(1);
    if (!existing) {
      throw new ElizaError("Shared agent memory id conflicts outside its tenant", {
        code: SHARED_AGENT_MEMORY_ID_CONFLICT,
        context: { organizationId: scope.organizationId, memoryId: input.id },
      });
    }
    return { id: existing.id, inserted: false };
  }

  /**
   * Atomically converges one stable assistant message across cancellation and
   * retry. The latest complete retry is authoritative; between interrupted
   * prefixes, only the longer visible text wins. Interrupted text can never
   * downgrade a complete reply.
   */
  async mergeMessageMemory(
    input: MergeSharedAgentMessageMemoryInput,
  ): Promise<InsertSharedAgentMemoryResult> {
    const scope = requiredScope(input.scope);
    if (typeof input.type !== "string" || input.type.trim().length === 0) {
      throw new ElizaError("Shared agent memory type is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "type" },
      });
    }
    const text = input.content.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new ElizaError("Shared agent message memory text is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "content.text" },
      });
    }
    if (input.embedding != null) assertEmbedding(input.embedding);
    const content = { ...input.content };
    delete content.interrupted;
    if (input.interrupted) content.interrupted = true;

    const [merged] = await dbWrite
      .insert(sharedAgentMemories)
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        user_id: scope.userId,
        agent_id: scope.agentId,
        entity_id: input.entityId ?? null,
        room_id: input.roomId ?? null,
        world_id: input.worldId ?? null,
        type: input.type,
        content: jsonbParam(content),
        embedding: input.embedding ?? null,
        embedding_model: input.embeddingModel ?? null,
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      })
      .onConflictDoUpdate({
        target: [sharedAgentMemories.id],
        set: { content: jsonbParam(content) },
        setWhere: sql`
          ${sharedAgentMemories.organization_id} = ${scope.organizationId}
          AND ${sharedAgentMemories.user_id} = ${scope.userId}
          AND ${sharedAgentMemories.agent_id} = ${scope.agentId}
          AND (
            ${input.interrupted} = false
            OR (
              COALESCE(${sharedAgentMemories.content}->>'interrupted' = 'true', false)
              AND length(COALESCE(${sql.raw("excluded.content")}->>'text', ''))
                > length(COALESCE(${sharedAgentMemories.content}->>'text', ''))
            )
          )
        `,
      })
      .returning({
        id: sharedAgentMemories.id,
        inserted: sql<boolean>`xmax = 0`,
      });
    if (merged) return merged;

    const [existing] = await dbRead
      .select({ id: sharedAgentMemories.id })
      .from(sharedAgentMemories)
      .where(and(...tenantPins(scope), eq(sharedAgentMemories.id, input.id)))
      .limit(1);
    if (!existing) {
      throw new ElizaError("Shared agent memory id conflicts outside its tenant", {
        code: SHARED_AGENT_MEMORY_ID_CONFLICT,
        context: { organizationId: scope.organizationId, memoryId: input.id },
      });
    }
    return { id: existing.id, inserted: false };
  }
}

export class SharedAgentMemoriesReader {
  /**
   * Tenant-pinned newest-first page for the product Memories surface. The
   * caller supplies validated UUID filters; this repository still bounds the
   * page and offset so a compatibility route cannot turn into an unbounded
   * tenant scan. `limit + 1` is fetched only to produce an honest `hasMore`.
   */
  async listPage(
    scope: SharedAgentMemoryScope,
    input: ListSharedAgentMemoriesInput,
  ): Promise<ListSharedAgentMemoriesResult> {
    assertLimit(input.limit);
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_LIST_OFFSET) {
      throw new ElizaError("Shared agent memory offset is outside bounds", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { offset, max: MAX_LIST_OFFSET },
      });
    }

    const predicates = productListPredicates(scope, input);
    if (input.before) {
      const cursor = input.beforeId
        ? or(
            lt(sharedAgentMemories.created_at, input.before),
            and(
              eq(sharedAgentMemories.created_at, input.before),
              lt(sharedAgentMemories.id, input.beforeId),
            ),
          )
        : lt(sharedAgentMemories.created_at, input.before);
      if (cursor) predicates.push(cursor);
    }

    const rows = await dbRead
      .select()
      .from(sharedAgentMemories)
      .where(and(...predicates))
      .orderBy(desc(sharedAgentMemories.created_at), desc(sharedAgentMemories.id))
      .limit(input.limit + 1)
      .offset(offset);
    return {
      rows: rows.slice(0, input.limit),
      hasMore: rows.length > input.limit,
    };
  }

  /** Exact count over the same tenant-pinned filters used by product listing. */
  async countMatching(
    scope: SharedAgentMemoryScope,
    input: CountSharedAgentMemoriesInput,
  ): Promise<number> {
    const [result] = await dbRead
      .select({ count: sql<number>`count(*)::int` })
      .from(sharedAgentMemories)
      .where(and(...productListPredicates(scope, input)));
    return result?.count ?? 0;
  }

  /** Exact per-type counts for one tenant-scoped Shared agent. */
  async countByType(scope: SharedAgentMemoryScope): Promise<SharedAgentMemoryTypeCount[]> {
    requiredScope(scope);
    return await dbRead
      .select({
        type: sharedAgentMemories.type,
        count: sql<number>`count(*)::int`,
      })
      .from(sharedAgentMemories)
      .where(and(...tenantPins(scope)))
      .groupBy(sharedAgentMemories.type)
      .orderBy(asc(sharedAgentMemories.type));
  }

  /** Most recent rows for one room within the tenant scope, newest first. */
  async listRecentByRoom(
    scope: SharedAgentMemoryScope,
    roomId: string,
    limit: number,
  ): Promise<SharedAgentMemoryRow[]> {
    requiredScope(scope);
    assertLimit(limit);
    if (typeof roomId !== "string" || roomId.trim().length === 0) {
      throw new ElizaError("Shared agent memory roomId is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "roomId" },
      });
    }
    return await dbRead
      .select()
      .from(sharedAgentMemories)
      .where(and(...tenantPins(scope), eq(sharedAgentMemories.room_id, roomId)))
      .orderBy(desc(sharedAgentMemories.created_at), desc(sharedAgentMemories.id))
      .limit(limit);
  }

  /**
   * Most recent rows of one core table-name discriminator (e.g. "facts")
   * within the tenant scope, newest first. Serves the Shared facts provider
   * (parity P4) without scanning message rows.
   */
  async listRecentByType(
    scope: SharedAgentMemoryScope,
    type: string,
    limit?: number,
  ): Promise<SharedAgentMemoryRow[]> {
    requiredScope(scope);
    if (limit !== undefined) assertLimit(limit);
    if (typeof type !== "string" || type.trim().length === 0) {
      throw new ElizaError("Shared agent memory type is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "type" },
      });
    }
    const query = dbRead
      .select()
      .from(sharedAgentMemories)
      .where(and(...tenantPins(scope), eq(sharedAgentMemories.type, type)))
      .orderBy(desc(sharedAgentMemories.created_at), desc(sharedAgentMemories.id));
    return await (limit === undefined ? query : query.limit(limit));
  }

  /**
   * Exact cosine-distance search over one trusted room's most recent embedded
   * rows within the tenant scope (bounded window; see module header). Only rows
   * whose stored vector has the query's dimensionality participate, so
   * mixed-model histories cannot fail the whole query.
   */
  async searchByEmbedding(
    scope: SharedAgentMemoryScope,
    roomId: string,
    embedding: number[],
    limit: number,
  ): Promise<SharedAgentMemorySearchHit[]> {
    requiredScope(scope);
    if (typeof roomId !== "string" || roomId.trim().length === 0) {
      throw new ElizaError("Shared agent memory roomId is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "roomId" },
      });
    }
    assertLimit(limit);
    assertEmbedding(embedding);
    const distance = sql<number>`(${sharedAgentMemories.embedding}::vector <=> ${vectorParam(
      embedding,
    )})`.as("distance");
    const recent = dbRead
      .select({
        id: sharedAgentMemories.id,
        organization_id: sharedAgentMemories.organization_id,
        user_id: sharedAgentMemories.user_id,
        agent_id: sharedAgentMemories.agent_id,
        entity_id: sharedAgentMemories.entity_id,
        room_id: sharedAgentMemories.room_id,
        world_id: sharedAgentMemories.world_id,
        type: sharedAgentMemories.type,
        content: sharedAgentMemories.content,
        embedding: sharedAgentMemories.embedding,
        embedding_model: sharedAgentMemories.embedding_model,
        created_at: sharedAgentMemories.created_at,
        distance,
      })
      .from(sharedAgentMemories)
      .where(
        and(
          ...tenantPins(scope),
          eq(sharedAgentMemories.room_id, roomId),
          isNotNull(sharedAgentMemories.embedding),
          sql`cardinality(${sharedAgentMemories.embedding}) = ${embedding.length}`,
        ),
      )
      .orderBy(desc(sharedAgentMemories.created_at), desc(sharedAgentMemories.id))
      .limit(SHARED_AGENT_MEMORY_SEARCH_WINDOW)
      .as("recent_shared_agent_memories");
    return await dbRead.select().from(recent).orderBy(asc(recent.distance)).limit(limit);
  }
}

export const sharedAgentMemoriesWriter = new SharedAgentMemoriesWriter();
export const sharedAgentMemoriesReader = new SharedAgentMemoriesReader();
