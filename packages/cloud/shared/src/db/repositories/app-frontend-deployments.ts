/**
 * AppFrontendDeployments repository.
 *
 * CRUD + lifecycle for managed frontend deployments. Writes go to the primary
 * (`dbWrite`), reads to `dbRead`. Activation is an atomic swap inside one
 * transaction (demote the current active → promote the target), backstopped by
 * the partial unique index `app_frontend_deployments_active_idx`.
 */

import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, isNotNull, isNull, max, ne, or, sql } from "drizzle-orm";
import { AppDeletionInProgressError } from "../../lib/services/app-deletion-authority";
import { dbRead, dbWrite } from "../helpers";
import {
  type AppFrontendDeployment,
  appFrontendDeployments,
  type FrontendBuildMeta,
  type FrontendManifest,
} from "../schemas/app-frontend-deployments";
import { type App, apps } from "../schemas/apps";

/** True when an error is a unique-violation on the (app_id, version) index. */
function isVersionRaceConflict(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "23505" || cause === "23505") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /app_frontend_deployments_app_version_idx|duplicate key value/i.test(message);
}

/** Raised inside the activation transaction to roll the demotion back. */
class DeploymentNotPromotable extends Error {}

export class AppFrontendDeploymentsRepository {
  /**
   * Create a new `pending` deployment. Version is assigned as max(version)+1
   * within the write transaction; the (app_id, version) unique index is the
   * race backstop. A concurrent create that loses the version race hits that
   * index — re-read + retry a bounded number of times so it surfaces as a fresh
   * version rather than a raw 500.
   */
  async create(input: {
    id?: string;
    appId: string;
    organizationId: string;
    r2Prefix: string;
    uploadGeneration?: string;
    uploadPlan?: FrontendManifest;
    createdByUserId?: string | null;
    buildMeta?: FrontendBuildMeta;
  }): Promise<AppFrontendDeployment> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await dbWrite.transaction(async (tx) => {
          const [app] = await tx
            .select({ id: apps.id, deletionJobId: apps.deletion_job_id })
            .from(apps)
            .where(and(eq(apps.id, input.appId), eq(apps.organization_id, input.organizationId)))
            .for("update");
          if (!app)
            throw new ElizaError("Frontend app owner is unavailable", {
              code: "FRONTEND_APP_OWNER_UNAVAILABLE",
            });
          if (app.deletionJobId) throw new AppDeletionInProgressError(app.id, app.deletionJobId);
          const [maxRow] = await tx
            .select({ maxVersion: max(appFrontendDeployments.version) })
            .from(appFrontendDeployments)
            .where(eq(appFrontendDeployments.app_id, input.appId));
          const version = (maxRow?.maxVersion ?? 0) + 1;
          const [row] = await tx
            .insert(appFrontendDeployments)
            .values({
              id: input.id,
              app_id: input.appId,
              upload_generation: input.uploadGeneration,
              upload_plan: input.uploadPlan,
              version,
              status: "pending",
              r2_prefix: input.r2Prefix,
              created_by_user_id: input.createdByUserId ?? null,
              build_meta: input.buildMeta ?? {},
            })
            .returning();
          return row;
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isVersionRaceConflict(error)) throw error;
      }
    }
  }

  async getById(id: string): Promise<AppFrontendDeployment | undefined> {
    // Used after deployment mutations; a replica can hide an acknowledged row.
    return await dbWrite.query.appFrontendDeployments.findFirst({
      where: eq(appFrontendDeployments.id, id),
    });
  }

  async getByIdForApp(appId: string, id: string): Promise<AppFrontendDeployment | undefined> {
    return await dbRead.query.appFrontendDeployments.findFirst({
      where: and(eq(appFrontendDeployments.id, id), eq(appFrontendDeployments.app_id, appId)),
    });
  }

  async listByApp(appId: string, limit = 50): Promise<AppFrontendDeployment[]> {
    return await dbRead.query.appFrontendDeployments.findMany({
      where: eq(appFrontendDeployments.app_id, appId),
      orderBy: [desc(appFrontendDeployments.version)],
      limit,
    });
  }

  /** The currently-live deployment for an app, if any. */
  async getActive(appId: string): Promise<AppFrontendDeployment | undefined> {
    return await dbRead.query.appFrontendDeployments.findFirst({
      where: and(
        eq(appFrontendDeployments.app_id, appId),
        eq(appFrontendDeployments.status, "active"),
      ),
    });
  }

  /** Finalize a deployment: attach the validated manifest and mark it `ready`. */
  async finalize(
    id: string,
    input: {
      r2Prefix: string;
      manifest: FrontendManifest;
      contentHash: string;
      fileCount: number;
      totalBytes: number;
    },
  ): Promise<AppFrontendDeployment | undefined> {
    const [row] = await dbWrite
      .update(appFrontendDeployments)
      .set({
        status: "ready",
        r2_prefix: input.r2Prefix,
        manifest: input.manifest,
        content_hash: input.contentHash,
        file_count: input.fileCount,
        total_bytes: input.totalBytes,
        error: null,
        finalized_at: new Date(),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(appFrontendDeployments.id, id),
          eq(appFrontendDeployments.status, "uploading"),
          or(
            isNull(appFrontendDeployments.upload_generation),
            isNotNull(appFrontendDeployments.upload_quiesced_at),
          ),
        ),
      )
      .returning();
    return row;
  }

  private async withUploadApp<T>(
    owner: Pick<App, "id" | "organization_id">,
    operation: (tx: import("../client").DbTransaction, deleting: boolean) => Promise<T>,
  ): Promise<T | undefined> {
    return dbWrite.transaction(async (tx) => {
      const [app] = await tx
        .select({ id: apps.id, deleting: apps.deletion_job_id })
        .from(apps)
        .where(and(eq(apps.id, owner.id), eq(apps.organization_id, owner.organization_id)))
        .for("update");
      if (!app) return undefined;
      return operation(tx, !!app.deleting);
    });
  }

  async beginUpload(
    owner: Pick<App, "id" | "organization_id">,
    id: string,
    generation?: string,
  ): Promise<AppFrontendDeployment | undefined> {
    return this.withUploadApp(owner, async (tx, deleting) => {
      if (deleting) return undefined;
      const [row] = await tx
        .update(appFrontendDeployments)
        .set({ status: "uploading", updated_at: new Date() })
        .where(
          and(
            eq(appFrontendDeployments.id, id),
            eq(appFrontendDeployments.app_id, owner.id),
            eq(appFrontendDeployments.status, "pending"),
            generation
              ? eq(appFrontendDeployments.upload_generation, generation)
              : isNull(appFrontendDeployments.upload_generation),
          ),
        )
        .returning();
      return row;
    });
  }

  /** Last local admission before each PUT; deletion waits for this writer's quiescence. */
  async assertUploadAuthority(
    owner: Pick<App, "id" | "organization_id">,
    id: string,
    generation: string,
  ): Promise<void> {
    const row = await this.withUploadApp(owner, async (tx, deleting) => {
      if (deleting) return undefined;
      const [owned] = await tx
        .select({ id: appFrontendDeployments.id })
        .from(appFrontendDeployments)
        .where(
          and(
            eq(appFrontendDeployments.id, id),
            eq(appFrontendDeployments.app_id, owner.id),
            eq(appFrontendDeployments.upload_generation, generation),
            eq(appFrontendDeployments.status, "uploading"),
            isNull(appFrontendDeployments.upload_quiesced_at),
          ),
        )
        .for("update");
      return owned;
    });
    if (!row)
      throw new ElizaError("Original frontend upload authority is unavailable", {
        code: "FRONTEND_UPLOAD_AUTHORITY_LOST",
        context: { deploymentId: id },
      });
  }

  /** Only the original writer, after every issued PUT acknowledges, may record no future PUTs. */
  async quiesceUpload(
    owner: Pick<App, "id" | "organization_id">,
    id: string,
    generation: string,
  ): Promise<AppFrontendDeployment | undefined> {
    return this.withUploadApp(owner, async (tx) => {
      const [row] = await tx
        .update(appFrontendDeployments)
        .set({
          upload_quiesced_at: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(appFrontendDeployments.id, id),
            eq(appFrontendDeployments.app_id, owner.id),
            eq(appFrontendDeployments.upload_generation, generation),
            isNull(appFrontendDeployments.upload_quiesced_at),
          ),
        )
        .returning();
      return row;
    });
  }

  /** Retire only unpublished work. Its returned row is the object cleanup authority. */
  async markFailed(id: string, error: string): Promise<AppFrontendDeployment | undefined> {
    const [row] = await dbWrite
      .update(appFrontendDeployments)
      .set({ status: "failed", error, updated_at: new Date() })
      .where(
        and(
          eq(appFrontendDeployments.id, id),
          inArray(appFrontendDeployments.status, ["pending", "uploading"]),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Atomically make `id` the single active deployment for the owned app: demote any
   * current active to `superseded`, then promote the target to `active`. The
   * partial unique index guarantees no two rows are ever active at once.
   */
  async activate(
    app: Pick<App, "id" | "organization_id">,
    id: string,
  ): Promise<AppFrontendDeployment | undefined> {
    try {
      return await this.activateOrRollBack(app, id);
    } catch (error) {
      if (error instanceof DeploymentNotPromotable) return undefined;
      throw error;
    }
  }

  private async activateOrRollBack(
    { id: appId, organization_id: organizationId }: Pick<App, "id" | "organization_id">,
    id: string,
  ): Promise<AppFrontendDeployment> {
    return await dbWrite.transaction(async (tx) => {
      // Share final app deletion's parent lock before touching deployments.
      // A mutable active-first ordering alone is insufficient when another
      // activation changes the active row while a deletion snapshot waits.
      const [app] = await tx
        .select({ id: apps.id, deletionJobId: apps.deletion_job_id })
        .from(apps)
        .where(and(eq(apps.id, appId), eq(apps.organization_id, organizationId)))
        .for("update");
      if (!app) throw new DeploymentNotPromotable();
      if (app.deletionJobId) throw new AppDeletionInProgressError(app.id, app.deletionJobId);
      await tx
        .update(appFrontendDeployments)
        .set({ status: "superseded", updated_at: new Date() })
        .where(
          and(
            eq(appFrontendDeployments.app_id, appId),
            eq(appFrontendDeployments.status, "active"),
            ne(appFrontendDeployments.id, id),
          ),
        );

      const now = new Date();
      const [row] = await tx
        .update(appFrontendDeployments)
        .set({ status: "active", activated_at: now, updated_at: now })
        .where(
          and(
            eq(appFrontendDeployments.id, id),
            eq(appFrontendDeployments.app_id, appId),
            inArray(appFrontendDeployments.status, ["ready", "superseded", "active"]),
          ),
        )
        .returning();
      // The target was deleted or left a promotable state after the caller
      // read it: roll the demotion back so the app keeps its live deployment.
      if (!row) throw new DeploymentNotPromotable();
      return row;
    });
  }

  /**
   * Delete a deployment row unless it is the active one, in one statement, so
   * a concurrent activation can never lose its live deployment. Returns the
   * deleted row, or undefined when none was deleted.
   */
  async deleteInactive(appId: string, id: string): Promise<AppFrontendDeployment | undefined> {
    const [row] = await dbWrite
      .delete(appFrontendDeployments)
      .where(
        and(
          eq(appFrontendDeployments.id, id),
          eq(appFrontendDeployments.app_id, appId),
          ne(appFrontendDeployments.status, "active"),
          or(
            eq(appFrontendDeployments.status, "pending"),
            inArray(appFrontendDeployments.status, ["ready", "superseded"]),
            isNotNull(appFrontendDeployments.upload_quiesced_at),
          ),
        ),
      )
      .returning();
    return row;
  }
}

export const appFrontendDeploymentsRepository = new AppFrontendDeploymentsRepository();
