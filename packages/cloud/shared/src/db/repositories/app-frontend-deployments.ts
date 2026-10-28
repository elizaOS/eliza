/**
 * AppFrontendDeployments repository.
 *
 * CRUD + lifecycle for managed frontend deployments. Writes go to the primary
 * (`dbWrite`), reads to `dbRead`. Activation is an atomic swap inside one
 * transaction (demote the current active → promote the target), backstopped by
 * the partial unique index `app_frontend_deployments_active_idx`.
 */

import { and, desc, eq, inArray, max, ne } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AppFrontendDeployment,
  appFrontendDeployments,
  type FrontendBuildMeta,
  type FrontendManifest,
} from "../schemas/app-frontend-deployments";

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
    appId: string;
    r2Prefix: string;
    createdByUserId?: string | null;
    buildMeta?: FrontendBuildMeta;
  }): Promise<AppFrontendDeployment> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        return await dbWrite.transaction(async (tx) => {
          const [maxRow] = await tx
            .select({ maxVersion: max(appFrontendDeployments.version) })
            .from(appFrontendDeployments)
            .where(eq(appFrontendDeployments.app_id, input.appId));
          const version = (maxRow?.maxVersion ?? 0) + 1;
          const [row] = await tx
            .insert(appFrontendDeployments)
            .values({
              app_id: input.appId,
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
    return await dbRead.query.appFrontendDeployments.findFirst({
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
        manifest: input.manifest,
        content_hash: input.contentHash,
        file_count: input.fileCount,
        total_bytes: input.totalBytes,
        error: null,
        finalized_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(appFrontendDeployments.id, id))
      .returning();
    return row;
  }

  /** Persist the R2 object-key prefix (known only after the id is assigned). */
  async setPrefix(id: string, r2Prefix: string): Promise<void> {
    await dbWrite
      .update(appFrontendDeployments)
      .set({ r2_prefix: r2Prefix, updated_at: new Date() })
      .where(eq(appFrontendDeployments.id, id));
  }

  async markStatus(id: string, status: AppFrontendDeployment["status"]): Promise<void> {
    await dbWrite
      .update(appFrontendDeployments)
      .set({ status, updated_at: new Date() })
      .where(eq(appFrontendDeployments.id, id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await dbWrite
      .update(appFrontendDeployments)
      .set({ status: "failed", error, updated_at: new Date() })
      .where(eq(appFrontendDeployments.id, id));
  }

  /**
   * Atomically make `id` the single active deployment for `appId`: demote any
   * current active to `superseded`, then promote the target to `active`. The
   * partial unique index guarantees no two rows are ever active at once.
   */
  async activate(appId: string, id: string): Promise<AppFrontendDeployment | undefined> {
    try {
      return await this.activateOrRollBack(appId, id);
    } catch (error) {
      if (error instanceof DeploymentNotPromotable) return undefined;
      throw error;
    }
  }

  private async activateOrRollBack(appId: string, id: string): Promise<AppFrontendDeployment> {
    return await dbWrite.transaction(async (tx) => {
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
        ),
      )
      .returning();
    return row;
  }
}

export const appFrontendDeploymentsRepository = new AppFrontendDeploymentsRepository();
