/**
 * AppContainerStore (Apps / Product 2) — the integration backing for the
 * {@link AppContainerStore} read/write seam declared in
 * `container-job-executors.ts`. It adapts the apps-lane executor's container
 * view onto 2AM's `containers` table via `containersRepository`, so the executor
 * itself never imports that schema/repo (decoupled per the seam's intent).
 *
 * IMPEDANCE MAP — the executor's AppContainerRow vs the `containers` columns:
 *   AppContainerRow.id              -> containers.id
 *   AppContainerRow.appId           -> containers.project_name  (the deploy
 *                                       orchestrator sets project_name = appId)
 *   AppContainerRow.containerName   -> containers.name
 *   AppContainerRow.image           -> containers.image_tag
 *   AppContainerRow.port            -> containers.port
 *   AppContainerRow.organizationId  -> containers.organization_id
 *   AppContainerRow.userId          -> containers.user_id
 *   AppContainerRow.environmentVars -> containers.environment_vars (jsonb;
 *                                       carries the per-tenant DATABASE_URL)
 *
 * markRunning persists {hostContainerId, hostPort, network}. The `containers`
 * table has NO dedicated columns for these (2AM's 2026-05-17 schema), so they
 * are merged into `containers.metadata` (the only free-form jsonb sink). When
 * 2AM's #8273 lands and ALTERs the schema, prefer real columns if it adds them;
 * until then `metadata` is canonical for host placement. We also stamp
 * `last_deployed_at` on success for the deploy-status poll.
 *
 * STATUS VOCAB (containers.ContainerStatus): pending | building | deploying |
 *   running | stopped | failed | deleting | deleted. We use:
 *     markRunning -> "running", markError -> "failed", markDeleted -> "stopped".
 *   ("stopped" keeps the partial unique index active_project_volume_unique happy:
 *   its predicate excludes status IN ('failed','stopped').)
 *
 * SERVER + NODE: this is a plain DB adapter (no `pg`), but it is wired into the
 * node daemon's container-executor deps (the daemon runs the provision against a
 * real worker node). `getById` uses a non-org-scoped read (the executor only has
 * the container id from the job payload; the repo's findById/update are
 * org-scoped, so we read the org from the row first, then call org-scoped update).
 */

import { eq } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { containersRepository } from "../../db/repositories/containers";
import { containers } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import { deriveAppPublicUrl } from "./app-url";
import type { AppContainerRow, AppContainerStore } from "./container-job-executors";

/** The `containers` columns the executor's view projects from (structural). */
export interface ProjectableContainerRow {
  id: string;
  name: string;
  project_name: string;
  image_tag: string | null;
  port: number;
  organization_id: string;
  user_id: string;
  environment_vars: Record<string, string> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Project a `containers` row onto the executor's {@link AppContainerRow}. Pure,
 * so the impedance map (image_tag→image, the appId fallback chain, the env-vars
 * carrying the per-tenant DSN) is unit-tested without a DB.
 */
export function mapContainerRowToAppContainerRow(row: ProjectableContainerRow): AppContainerRow {
  const metaAppId =
    typeof row.metadata?.appId === "string" ? (row.metadata.appId as string) : undefined;
  return {
    id: row.id,
    // project_name is set to the appId by the deploy orchestrator's
    // createContainerRow; metadata.appId is a belt-and-suspenders fallback.
    appId: metaAppId ?? row.project_name,
    containerName: row.name,
    image: row.image_tag ?? "",
    port: row.port,
    organizationId: row.organization_id,
    userId: row.user_id,
    environmentVars: row.environment_vars ?? undefined,
  };
}

/**
 * Merge host-placement fields into a container's metadata jsonb, preserving
 * everything already there (e.g. `appId`). Pure — the 2AM `containers` schema
 * has no dedicated host columns, so metadata is the canonical placement sink.
 */
export function mergeHostPlacementMetadata(
  existing: Record<string, unknown> | null | undefined,
  info: { hostContainerId: string; hostPort: number; network: string; nodeHost?: string },
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    hostContainerId: info.hostContainerId,
    hostPort: info.hostPort,
    network: info.network,
    // `hostname` = the node the container runs on. This is the key the ingress-map
    // snapshot reads to build a per-app upstream — without it the snapshot could
    // never emit one (latent gap). Only written when known.
    ...(info.nodeHost ? { hostname: info.nodeHost } : {}),
  };
}

/** Read/write seam impl over `containersRepository` + a direct id-scoped read. */
export class ContainerRepoAppContainerStore implements AppContainerStore {
  async getById(containerId: string): Promise<AppContainerRow | null> {
    // The executor only has the container id (from the job payload), but the
    // repo's findById is org-scoped. Read by primary key directly to recover the
    // full row (incl. organization_id), then project onto AppContainerRow.
    const [row] = await dbRead
      .select()
      .from(containers)
      .where(eq(containers.id, containerId))
      .limit(1);
    if (!row) return null;
    return mapContainerRowToAppContainerRow(row);
  }

  async markRunning(
    containerId: string,
    info: { hostContainerId: string; hostPort: number; network: string; nodeHost?: string },
  ): Promise<void> {
    const [row] = await dbRead
      .select({ organization_id: containers.organization_id, metadata: containers.metadata })
      .from(containers)
      .where(eq(containers.id, containerId))
      .limit(1);
    if (!row) {
      logger.warn("[AppContainerStore] markRunning: container not found", { containerId });
      return;
    }

    // Merge host placement into metadata (no dedicated columns on the 2AM
    // schema), preserving anything already there (e.g. appId).
    const nextMetadata = mergeHostPlacementMetadata(row.metadata, info);

    // Stamp the app's public URL via the SAME ingress hostname derivation the
    // agent path uses (reused, not rebuilt) so the running app is reachable at
    // a real URL. Skipped when no public base domain is configured (local dev).
    const endpoint = deriveAppPublicUrl(containerId);

    // Two writes: status (id-scoped) + metadata/url/last_deployed_at (org-scoped
    // update, which is the only metadata-writing surface the repo exposes).
    await containersRepository.updateStatus(containerId, "running");
    await containersRepository.update(containerId, row.organization_id, {
      metadata: nextMetadata,
      last_deployed_at: new Date(),
      ...(endpoint ? { public_hostname: endpoint.hostname, load_balancer_url: endpoint.url } : {}),
    });
  }

  async markDeleted(containerId: string): Promise<void> {
    // "stopped" rather than the terminal "deleted" so a redeploy can reuse the
    // row; both satisfy the active_project_volume_unique predicate exclusion.
    await containersRepository.updateStatus(containerId, "stopped");
  }

  async markError(containerId: string, error: string): Promise<void> {
    await containersRepository.updateStatus(containerId, "failed", error);
  }
}

/** Singleton — wired into the daemon's container-executor deps. */
export const appContainerStore: AppContainerStore = new ContainerRepoAppContainerStore();
