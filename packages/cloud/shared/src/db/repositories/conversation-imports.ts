// Persists conversation-import batches, resumable upload sessions, and artifacts through the shared DB boundary.
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type ImportArtifactRow,
  type ImportBatch,
  type ImportUploadSessionRow,
  importArtifacts,
  importBatches,
  importUploadSessions,
  type NewImportArtifactRow,
  type NewImportBatch,
  type NewImportUploadSessionRow,
} from "../schemas/conversation-imports";

export type {
  ImportArtifactRow,
  ImportBatch,
  ImportUploadSessionRow,
  NewImportArtifactRow,
  NewImportBatch,
  NewImportUploadSessionRow,
};

function boundedLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

export class ImportBatchesRepository {
  async create(data: NewImportBatch): Promise<ImportBatch> {
    const [row] = await dbWrite.insert(importBatches).values(data).returning();
    return row;
  }

  async findByOrgAndId(organizationId: string, id: string): Promise<ImportBatch | undefined> {
    return await dbRead.query.importBatches.findFirst({
      where: and(eq(importBatches.organization_id, organizationId), eq(importBatches.id, id)),
    });
  }

  async listByOrganization(
    organizationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{
    items: ImportBatch[];
    hasMore: boolean;
    limit: number;
    offset: number;
  }> {
    const limit = boundedLimit(options.limit);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = await dbRead.query.importBatches.findMany({
      where: eq(importBatches.organization_id, organizationId),
      orderBy: desc(importBatches.created_at),
      limit: limit + 1,
      offset,
    });
    return {
      items: rows.slice(0, limit),
      hasMore: rows.length > limit,
      limit,
      offset,
    };
  }

  /**
   * Transitions a batch out of `fromStatuses` exactly once. Returns the
   * updated row when this caller won the transition, `undefined` when the
   * batch was already past it — the guard that keeps quota release idempotent.
   */
  async transitionStatus(
    organizationId: string,
    id: string,
    fromStatuses: string[],
    toStatus: string,
    extra: Partial<Pick<NewImportBatch, "reserved_bytes" | "deleted_at">> = {},
  ): Promise<ImportBatch | undefined> {
    const [row] = await dbWrite
      .update(importBatches)
      .set({ status: toStatus, updated_at: new Date(), ...extra })
      .where(
        and(
          eq(importBatches.organization_id, organizationId),
          eq(importBatches.id, id),
          inArray(importBatches.status, fromStatuses),
        ),
      )
      .returning();
    return row;
  }
}

export class ImportUploadSessionsRepository {
  async create(data: NewImportUploadSessionRow): Promise<ImportUploadSessionRow> {
    const [row] = await dbWrite.insert(importUploadSessions).values(data).returning();
    return row;
  }

  async findByOrgAndId(
    organizationId: string,
    id: string,
  ): Promise<ImportUploadSessionRow | undefined> {
    return await dbRead.query.importUploadSessions.findFirst({
      where: and(
        eq(importUploadSessions.organization_id, organizationId),
        eq(importUploadSessions.id, id),
      ),
    });
  }

  async findOpenByBatch(
    organizationId: string,
    batchId: string,
  ): Promise<ImportUploadSessionRow[]> {
    return await dbRead.query.importUploadSessions.findMany({
      where: and(
        eq(importUploadSessions.organization_id, organizationId),
        eq(importUploadSessions.batch_id, batchId),
        eq(importUploadSessions.status, "open"),
      ),
      orderBy: asc(importUploadSessions.created_at),
    });
  }

  /**
   * Optimistic-concurrency write of the serialized resumable session state.
   * The WHERE clause pins the core state's `updatedAt` so two concurrent chunk
   * appends cannot silently drop each other's chunks; the loser reloads,
   * merges via the core primitive, and retries.
   */
  async compareAndSwapState(
    organizationId: string,
    id: string,
    expectedStateUpdatedAt: number,
    update: {
      sessionState: Record<string, unknown>;
      partEtags: Record<string, string>;
      status: string;
    },
  ): Promise<ImportUploadSessionRow | undefined> {
    const [row] = await dbWrite
      .update(importUploadSessions)
      .set({
        session_state: update.sessionState,
        part_etags: update.partEtags,
        status: update.status,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(importUploadSessions.organization_id, organizationId),
          eq(importUploadSessions.id, id),
          eq(importUploadSessions.status, "open"),
          sql`(${importUploadSessions.session_state}->>'updatedAt')::bigint = ${expectedStateUpdatedAt}`,
        ),
      )
      .returning();
    return row;
  }

  /** Transitions session status with a from-status guard (idempotent abort/complete). */
  async transitionStatus(
    organizationId: string,
    id: string,
    fromStatuses: string[],
    toStatus: string,
  ): Promise<ImportUploadSessionRow | undefined> {
    const [row] = await dbWrite
      .update(importUploadSessions)
      .set({ status: toStatus, updated_at: new Date() })
      .where(
        and(
          eq(importUploadSessions.organization_id, organizationId),
          eq(importUploadSessions.id, id),
          inArray(importUploadSessions.status, fromStatuses),
        ),
      )
      .returning();
    return row;
  }

  async findExpiredOpen(now: Date, limit: number): Promise<ImportUploadSessionRow[]> {
    return await dbRead.query.importUploadSessions.findMany({
      where: and(
        eq(importUploadSessions.status, "open"),
        lte(importUploadSessions.expires_at, now),
      ),
      orderBy: asc(importUploadSessions.expires_at),
      limit: boundedLimit(limit),
    });
  }
}

export class ImportArtifactsRepository {
  async create(data: NewImportArtifactRow): Promise<ImportArtifactRow> {
    const [row] = await dbWrite.insert(importArtifacts).values(data).returning();
    return row;
  }

  async findActiveByOrgAndId(
    organizationId: string,
    id: string,
  ): Promise<ImportArtifactRow | undefined> {
    return await dbRead.query.importArtifacts.findFirst({
      where: and(
        eq(importArtifacts.organization_id, organizationId),
        eq(importArtifacts.id, id),
        eq(importArtifacts.status, "active"),
      ),
    });
  }

  async findActiveByBatchAndKey(
    organizationId: string,
    batchId: string,
    storageKey: string,
  ): Promise<ImportArtifactRow | undefined> {
    return await dbRead.query.importArtifacts.findFirst({
      where: and(
        eq(importArtifacts.organization_id, organizationId),
        eq(importArtifacts.batch_id, batchId),
        eq(importArtifacts.storage_key, storageKey),
        eq(importArtifacts.status, "active"),
      ),
    });
  }

  async listActiveByBatch(organizationId: string, batchId: string): Promise<ImportArtifactRow[]> {
    return await dbRead.query.importArtifacts.findMany({
      where: and(
        eq(importArtifacts.organization_id, organizationId),
        eq(importArtifacts.batch_id, batchId),
        eq(importArtifacts.status, "active"),
      ),
      orderBy: asc(importArtifacts.created_at),
    });
  }

  /** Soft-deletes exactly once; returns undefined when the row was already deleted. */
  async softDeleteByOrgAndId(
    organizationId: string,
    id: string,
  ): Promise<ImportArtifactRow | undefined> {
    const [row] = await dbWrite
      .update(importArtifacts)
      .set({ status: "deleted", deleted_at: new Date(), updated_at: new Date() })
      .where(
        and(
          eq(importArtifacts.organization_id, organizationId),
          eq(importArtifacts.id, id),
          eq(importArtifacts.status, "active"),
        ),
      )
      .returning();
    return row;
  }

  async findExpiredActive(now: Date, limit: number): Promise<ImportArtifactRow[]> {
    return await dbRead.query.importArtifacts.findMany({
      where: and(
        eq(importArtifacts.status, "active"),
        eq(importArtifacts.retention_mode, "short-lived"),
        lte(importArtifacts.expires_at, now),
      ),
      orderBy: asc(importArtifacts.expires_at),
      limit: boundedLimit(limit),
    });
  }
}

export const importBatchesRepository = new ImportBatchesRepository();
export const importUploadSessionsRepository = new ImportUploadSessionsRepository();
export const importArtifactsRepository = new ImportArtifactsRepository();
