/**
 * Adapts app-container executor state transitions onto the shared `containers` table.
 * The executor consumes this boundary without importing database concerns. Host
 * placement stays in metadata because the schema has no dedicated host columns,
 * while terminal `deleted` status is required to release organization quota.
 */

import { and, eq } from "drizzle-orm";
import type { dbWrite } from "../../db/helpers";
import type { containersRepository } from "../../db/repositories/containers";
import { containers } from "../../db/schemas/containers";
import {
  type AppContainerNodeSlotClaim,
  type AppContainerReadDatabase,
  type AppContainerTransactionDatabase,
  claimAppContainerNodeSlot,
  findAppContainerRowById,
  findDeletingAppContainerRows,
  type ProjectableContainerRow,
  rollbackAppContainerNodeSlotClaim,
} from "./app-container-store-queries";
import { deriveAppPublicUrl } from "./app-url";
import type { AppContainerRow, AppContainerStore } from "./container-job-executors";

export type { ProjectableContainerRow } from "./app-container-store-queries";

type AppContainerWriteDatabase = AppContainerReadDatabase &
  AppContainerTransactionDatabase &
  Pick<typeof dbWrite, "update">;

/** Existing container-repository operations used for lifecycle side effects. */
export type AppContainerStoreRepository = Pick<
  typeof containersRepository,
  "tryReleaseNodeSlot" | "update" | "updateStatus"
>;

/** Structural error metadata translated to ElizaError by runtime composition. */
export interface AppContainerStoreErrorOptions {
  code: string;
  context: Record<string, unknown>;
  severity: "ephemeral" | "fatal";
}

/** Injectable persistence and error boundaries for the app-container store. */
export interface ContainerRepoAppContainerStoreDeps {
  readDatabase: AppContainerReadDatabase;
  writeDatabase: AppContainerWriteDatabase;
  repository: AppContainerStoreRepository;
  errorFactory: (message: string, options: AppContainerStoreErrorOptions) => Error;
}

/**
 * Project a `containers` row onto the executor's {@link AppContainerRow}. Pure,
 * so the impedance map (image_tag→image, the appId fallback chain, the env-vars
 * carrying the per-tenant DSN) is unit-tested without a DB.
 */
export function mapContainerRowToAppContainerRow(row: ProjectableContainerRow): AppContainerRow {
  const metaAppId =
    typeof row.metadata?.appId === "string" ? (row.metadata.appId as string) : undefined;
  const hostContainerId =
    typeof row.metadata?.hostContainerId === "string" ? row.metadata.hostContainerId : undefined;
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
    nodeId: row.node_id ?? undefined,
    hostContainerId,
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
  constructor(private readonly deps: ContainerRepoAppContainerStoreDeps) {}

  async getById(containerId: string): Promise<AppContainerRow | null> {
    // The executor only has the container id (from the job payload), but the
    // repo's findById is org-scoped. Read by primary key directly to recover the
    // full row (incl. organization_id), then project onto AppContainerRow.
    const row = await findAppContainerRowById(this.deps.readDatabase, containerId);
    if (!row) return null;
    return mapContainerRowToAppContainerRow(row);
  }

  async findDeletingByOrganization(organizationId: string): Promise<AppContainerRow[]> {
    // A recovered legacy job is consumed once, so replica lag must not turn a
    // real deleting row into a terminal no-op.
    const rows = await findDeletingAppContainerRows(this.deps.writeDatabase, organizationId);
    return rows.map(mapContainerRowToAppContainerRow);
  }

  async claimNodeSlot(
    containerId: string,
    organizationId: string,
    nodeId: string,
  ): Promise<AppContainerNodeSlotClaim> {
    return claimAppContainerNodeSlot(
      this.deps.writeDatabase,
      containerId,
      organizationId,
      nodeId,
      () =>
        this.deps.errorFactory(`Docker node ${nodeId} has no available app-container slot`, {
          code: "APP_CONTAINER_NODE_CAPACITY_UNAVAILABLE",
          context: { containerId, organizationId, nodeId },
          severity: "ephemeral",
        }),
      (existing) =>
        this.deps.errorFactory(`App container ${containerId} has a conflicting node-slot claim`, {
          code: "APP_CONTAINER_NODE_SLOT_CONFLICT",
          context: { containerId, organizationId, requestedNodeId: nodeId, existing },
          severity: "fatal",
        }),
    );
  }

  async rollbackNodeSlotClaim(
    containerId: string,
    organizationId: string,
    nodeId: string,
  ): Promise<boolean> {
    return rollbackAppContainerNodeSlotClaim(
      this.deps.writeDatabase,
      containerId,
      organizationId,
      nodeId,
    );
  }

  async markRunning(
    containerId: string,
    info: { hostContainerId: string; hostPort: number; network: string; nodeHost?: string },
  ): Promise<void> {
    const [row] = await this.deps.readDatabase
      .select({ organization_id: containers.organization_id, metadata: containers.metadata })
      .from(containers)
      .where(eq(containers.id, containerId))
      .limit(1);
    if (!row) {
      throw this.deps.errorFactory(
        `App container ${containerId} disappeared before it became running`,
        {
          code: "APP_CONTAINER_ROW_MISSING",
          context: { containerId, transition: "running" },
          severity: "fatal",
        },
      );
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
    await this.deps.repository.updateStatus(containerId, "running");
    await this.deps.repository.update(containerId, row.organization_id, {
      metadata: nextMetadata,
      last_deployed_at: new Date(),
      ...(endpoint ? { public_hostname: endpoint.hostname, load_balancer_url: endpoint.url } : {}),
    });
  }

  async markDeleted(containerId: string, organizationId: string, nodeId?: string): Promise<void> {
    // Terminal "deleted" — the daemon has actually removed the container, so the
    // row must reach a state that does NOT count toward the per-org container
    // quota. `checkQuota`/`createWithQuotaCheck` exclude only `deleting`/`deleted`;
    // a `stopped` row would keep leaking quota across redeploys (the daemon never
    // reuses this row — each deploy creates a fresh one). App containers carry no
    // `volume_path`, so the active_project_volume_unique index never applies here.
    if (nodeId) {
      await this.deps.repository.tryReleaseNodeSlot(containerId, organizationId, nodeId);
    }
    await this.deps.writeDatabase
      .update(containers)
      .set({ status: "deleted", error_message: null, updated_at: new Date() })
      .where(and(eq(containers.id, containerId), eq(containers.organization_id, organizationId)));
  }

  async markError(containerId: string, error: string): Promise<void> {
    await this.deps.repository.updateStatus(containerId, "failed", error);
  }

  async markCleanupRequired(containerId: string, error: string): Promise<void> {
    await this.deps.writeDatabase
      .update(containers)
      .set({ status: "cleanup_required", error_message: error, updated_at: new Date() })
      .where(eq(containers.id, containerId));
  }
}
