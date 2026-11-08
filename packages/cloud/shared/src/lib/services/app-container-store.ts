/**
 * Adapts app-container executor state transitions onto the shared `containers` table.
 * The executor consumes this boundary without importing database concerns. Host
 * placement stays in metadata because the schema has no dedicated host columns,
 * while terminal `deleted` status is required to release organization quota.
 */

import { and, eq, ne, sql } from "drizzle-orm";
import type { dbWrite } from "../../db/helpers";
import type { containersRepository } from "../../db/repositories/containers";
import { containers, TERMINAL_CONTAINER_STATUS } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import {
  type AppContainerNodeSlotClaim,
  type AppContainerPublicationAuthority,
  type AppContainerReadDatabase,
  type AppContainerTransactionDatabase,
  claimAppContainerNodeSlot,
  findAppContainerRowById,
  findDeletingAppContainerRows,
  hasOtherAppContainerOnNode,
  type ProjectableContainerRow,
  rollbackAppContainerNodeSlotClaim,
} from "./app-container-store-queries";
import { deploymentGenerationFromMetadata } from "./app-deployment-generation";
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
  const deploymentGeneration = deploymentGenerationFromMetadata(row.metadata);
  return {
    id: row.id,
    // project_name is set to the appId by the deploy orchestrator's
    // createContainerRow; metadata.appId is a belt-and-suspenders fallback.
    appId: metaAppId ?? row.project_name,
    ...(deploymentGeneration ? { deploymentGeneration } : {}),
    containerName: row.name,
    image: row.image_tag ?? "",
    port: row.port,
    organizationId: row.organization_id,
    createdAtSnapshot: row.createdAtSnapshot,
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

  async hasOtherAppContainerOnNode(row: AppContainerRow): Promise<boolean> {
    if (!row.nodeId) return false;
    return hasOtherAppContainerOnNode(this.deps.writeDatabase, {
      id: row.id,
      organizationId: row.organizationId,
      appId: row.appId,
      nodeId: row.nodeId,
    });
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
    authority?: AppContainerPublicationAuthority,
  ): Promise<boolean> {
    return rollbackAppContainerNodeSlotClaim(
      this.deps.writeDatabase,
      containerId,
      organizationId,
      nodeId,
      authority,
    );
  }

  private async readPublicationRow(
    containerId: string,
    authority: AppContainerPublicationAuthority,
  ) {
    const [row] = await this.deps.writeDatabase
      .select({
        organization_id: containers.organization_id,
        status: containers.status,
        lifecycle_revision: containers.lifecycle_revision,
        metadata: containers.metadata,
        created_at: containers.created_at,
        createdAtSnapshot: sql<string>`to_char(${containers.created_at}, 'YYYY-MM-DD HH24:MI:SS.US')`,
      })
      .from(containers)
      .where(
        and(
          eq(containers.id, containerId),
          eq(containers.organization_id, authority.organizationId),
        ),
      )
      .limit(1);
    return row;
  }

  private publicationMatches(
    row: Awaited<ReturnType<ContainerRepoAppContainerStore["readPublicationRow"]>>,
    authority: AppContainerPublicationAuthority,
  ): boolean {
    return (
      !!row &&
      row.createdAtSnapshot === authority.createdAtSnapshot &&
      deploymentGenerationFromMetadata(row.metadata) === authority.deploymentGeneration &&
      row.status !== "deleting" &&
      row.status !== TERMINAL_CONTAINER_STATUS &&
      !Object.hasOwn(row.metadata ?? {}, "retirement")
    );
  }

  async markRunning(
    containerId: string,
    info: { hostContainerId: string; hostPort: number; network: string; nodeHost?: string },
    authority: AppContainerPublicationAuthority,
  ): Promise<void> {
    const row = await this.readPublicationRow(containerId, authority);
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
    const stale = () =>
      this.deps.errorFactory(
        `App container ${containerId} reached a retired or changed generation before it became running`,
        {
          code: "APP_CONTAINER_PUBLICATION_STALE",
          context: {
            containerId,
            organizationId: authority.organizationId,
            deploymentGeneration: authority.deploymentGeneration,
            transition: "running",
          },
          severity: "ephemeral",
        },
      );
    if (!this.publicationMatches(row, authority)) throw stale();
    const endpoint = deriveAppPublicUrl(containerId);
    // Status, placement and publication timestamp have one linearization point.
    // The canonical CAS rechecks the original row, revision and complete metadata;
    // a concurrent retirement or generation change owns the row if it wins first.
    const published = await this.deps.repository.update(
      containerId,
      authority.organizationId,
      {
        status: "running",
        metadata: mergeHostPlacementMetadata(row.metadata, info),
        last_deployed_at: new Date(),
        ...(endpoint
          ? { public_hostname: endpoint.hostname, load_balancer_url: endpoint.url }
          : {}),
      },
      row,
    );
    if (!published) throw stale();
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

  private async markOwnedFailure(
    containerId: string,
    error: string,
    status: "failed" | "cleanup_required",
    authority: AppContainerPublicationAuthority,
  ): Promise<void> {
    const row = await this.readPublicationRow(containerId, authority);
    if (!row || !this.publicationMatches(row, authority)) {
      logger.info("[AppContainerStore] newer lifecycle owns failure publication", {
        containerId,
        deploymentGeneration: authority.deploymentGeneration,
        status,
      });
      return;
    }
    const written = await this.deps.repository.update(
      containerId,
      authority.organizationId,
      { status, error_message: error },
      row,
    );
    if (!written) {
      logger.info("[AppContainerStore] newer lifecycle won failure publication", {
        containerId,
        deploymentGeneration: authority.deploymentGeneration,
        status,
      });
    }
  }

  async markError(
    containerId: string,
    error: string,
    authority?: AppContainerPublicationAuthority,
  ): Promise<void> {
    if (authority) return this.markOwnedFailure(containerId, error, "failed", authority);
    await this.deps.repository.updateStatus(containerId, "failed", error);
  }

  async markCleanupRequired(
    containerId: string,
    error: string,
    authority?: AppContainerPublicationAuthority,
  ): Promise<void> {
    if (authority) return this.markOwnedFailure(containerId, error, "cleanup_required", authority);
    await this.deps.writeDatabase
      .update(containers)
      .set({ status: "cleanup_required", error_message: error, updated_at: new Date() })
      .where(and(eq(containers.id, containerId), ne(containers.status, TERMINAL_CONTAINER_STATUS)));
  }
}
