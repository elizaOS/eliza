/**
 * Tenant-scoped CQRS access to `shared_agent_memories`, the durable core-shape
 * memory rows written by container-free Shared runtimes. The writer owns
 * idempotent inserts and monotonic message convergence; the reader owns room-recency listing and embedding
 * search. Every SQL predicate pins `organization_id` AND `user_id` — a row is
 * never reachable through this module from outside its owning tenant.
 *
 * Embedding search tradeoff: the column is `real[]` (mirroring the core
 * memories row), so there is no ANN index; `searchByEmbedding` runs exact
 * pgvector cosine distance (`::vector <=> ::vector`, extension created in
 * migration 0000) over a bounded most-recent window of the tenant's rows.
 * Cost is therefore O(window) per query regardless of table size, and rows
 * older than the window are invisible to semantic recall by design.
 */
import { ElizaError } from "@elizaos/core";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import { type SharedAgentMemoryRow, sharedAgentMemories } from "../schemas/shared-agent-memories";
import { jsonbParam } from "../utils/jsonb";

export const SHARED_AGENT_MEMORY_INVALID_INPUT = "SHARED_AGENT_MEMORY_INVALID_INPUT";
export const SHARED_AGENT_MEMORY_ID_CONFLICT = "SHARED_AGENT_MEMORY_ID_CONFLICT";

/** Rows semantically scanned per embedding search (see module header). */
export const SHARED_AGENT_MEMORY_SEARCH_WINDOW = 512;
const MAX_LIST_LIMIT = 200;
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

export interface MergeSharedAgentMessageMemoryInput
  extends Omit<InsertSharedAgentMemoryInput, "id"> {
  /** Stable transport id shared by interrupted attempts and their retry. */
  id: string;
  /** Whether this row contains only the client-visible interrupted prefix. */
  interrupted: boolean;
}

export interface SetSharedAgentMemoryEmbeddingInput {
  id: string;
  scope: SharedAgentMemoryScope;
  /** Exact row content embedded; stale interrupted enrichments must not win a retry race. */
  contentText: string;
  embedding: number[];
  embeddingModel: string;
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
    let embeddingModel: string | null = null;
    if (input.embedding != null) {
      assertEmbedding(input.embedding);
      embeddingModel = input.embeddingModel?.trim() ?? "";
      if (!embeddingModel) {
        throw new ElizaError(
          "Shared agent message memory embedding and embedding model must be supplied together",
          {
            code: SHARED_AGENT_MEMORY_INVALID_INPUT,
            context: { field: "embeddingModel" },
          },
        );
      }
    } else if (input.embeddingModel != null) {
      throw new ElizaError(
        "Shared agent message memory embedding and embedding model must be supplied together",
        {
          code: SHARED_AGENT_MEMORY_INVALID_INPUT,
          context: { field: "embedding" },
        },
      );
    }
    const content = { ...input.content };
    delete content.interrupted;
    if (input.interrupted) content.interrupted = true;

    // Embeddings describe content.text, not the row id. A winning retry with
    // new text must not inherit the prior prefix's vector. Keep the existing
    // pair only when the embeddable text is unchanged; an incoming attested
    // pair replaces both columns in the same UPSERT statement.
    const retainedEmbedding = sql<number[] | null>`CASE
      WHEN ${sharedAgentMemories.content}->>'text'
        IS DISTINCT FROM ${sql.raw("excluded.content")}->>'text'
      THEN NULL
      ELSE ${sharedAgentMemories.embedding}
    END`;
    const retainedEmbeddingModel = sql<string | null>`CASE
      WHEN ${sharedAgentMemories.content}->>'text'
        IS DISTINCT FROM ${sql.raw("excluded.content")}->>'text'
      THEN NULL
      ELSE ${sharedAgentMemories.embedding_model}
    END`;

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
        embedding_model: embeddingModel,
        ...(input.createdAt ? { created_at: input.createdAt } : {}),
      })
      .onConflictDoUpdate({
        target: [sharedAgentMemories.id],
        set: {
          content: jsonbParam(content),
          embedding: input.embedding ?? retainedEmbedding,
          embedding_model: embeddingModel ?? retainedEmbeddingModel,
        },
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

  /**
   * Atomically enrich one already-landed tenant row with its attested vector
   * and space fingerprint. Used by Worker waitUntil jobs so durable transcript
   * writes need not wait for provider embedding latency. The content predicate
   * makes a stale interrupted-turn job a no-op after a complete retry wins.
   */
  async setMemoryEmbedding(input: SetSharedAgentMemoryEmbeddingInput): Promise<boolean> {
    const scope = requiredScope(input.scope);
    assertEmbedding(input.embedding);
    const embeddingModel = input.embeddingModel.trim();
    if (!embeddingModel) {
      throw new ElizaError("Shared agent memory embedding model is required", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "embeddingModel" },
      });
    }
    const [updated] = await dbWrite
      .update(sharedAgentMemories)
      .set({
        embedding: input.embedding,
        embedding_model: embeddingModel,
      })
      .where(
        and(
          ...tenantPins(scope),
          eq(sharedAgentMemories.id, input.id),
          sql`${sharedAgentMemories.content}->>'text' = ${input.contentText}`,
        ),
      )
      .returning({ id: sharedAgentMemories.id });
    return Boolean(updated);
  }
}

export class SharedAgentMemoriesReader {
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
   * Exact cosine-distance search over the tenant's most recent embedded rows
   * (bounded window; see module header). Only rows whose stored vector has the
   * query's dimensionality participate. Callers that persist a vector-space
   * fingerprint must pass it here as `embeddingModel`; same-width vectors from
   * another model/pooling/normalization contract are then excluded too.
   */
  async searchByEmbedding(
    scope: SharedAgentMemoryScope,
    embedding: number[],
    limit: number,
    embeddingModel?: string,
  ): Promise<SharedAgentMemorySearchHit[]> {
    requiredScope(scope);
    assertLimit(limit);
    assertEmbedding(embedding);
    const normalizedEmbeddingModel = embeddingModel?.trim();
    if (embeddingModel !== undefined && !normalizedEmbeddingModel) {
      throw new ElizaError("Shared agent memory embedding model is required when provided", {
        code: SHARED_AGENT_MEMORY_INVALID_INPUT,
        context: { field: "embeddingModel" },
      });
    }
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
          isNotNull(sharedAgentMemories.embedding),
          sql`cardinality(${sharedAgentMemories.embedding}) = ${embedding.length}`,
          ...(normalizedEmbeddingModel
            ? [eq(sharedAgentMemories.embedding_model, normalizedEmbeddingModel)]
            : []),
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
