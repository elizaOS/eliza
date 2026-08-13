/**
 * Persists Docker node records for cloud scheduling and control-plane health.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "../../lib/utils/logger";
import { dbRead, dbWrite } from "../helpers";
import {
  type DockerNode,
  type DockerNodeStatus,
  dockerNodes,
  type NewDockerNode,
  PLACEABLE_NODE_STATE,
} from "../schemas/docker-nodes";

export type { DockerNode, DockerNodeStatus, NewDockerNode };

function currentDeploymentEnvironment(): string | null {
  const env = typeof process !== "undefined" ? process.env.ENVIRONMENT?.trim() : undefined;
  return env ? env : null;
}

export function stampDockerNodeEnvironmentMetadata(
  metadata: Record<string, unknown> | null | undefined,
  environment: string | null = currentDeploymentEnvironment(),
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...metadata } : {};
  const existing = base.environment;
  if (!environment || (typeof existing === "string" && existing.trim().length > 0)) {
    return base;
  }
  return { ...base, environment };
}

function currentEnvironmentPredicate() {
  const environment = currentDeploymentEnvironment();
  if (!environment) return sql`TRUE`;
  return sql`(
    COALESCE(${dockerNodes.metadata}->>'environment', '') = ''
    OR ${dockerNodes.metadata}->>'environment' = ${environment}
  )`;
}

/** Provisional autoscaler capacity must never count as schedulable authority. */
function capacityAttestedPredicate() {
  return sql`COALESCE(${dockerNodes.metadata}->>'capacityProvisional', 'false') <> 'true'`;
}

export class DockerNodesRepository {
  // ============================================================================
  // READ OPERATIONS
  // ============================================================================

  async findAll(): Promise<DockerNode[]> {
    return dbRead.select().from(dockerNodes).orderBy(asc(dockerNodes.node_id));
  }

  /**
   * Every operationally live node, INCLUDING cordoned ones.
   *
   * This is the operational set, not the placement set: health checks,
   * allocated-count sync, disk monitoring, image pre-pull, and the orphan
   * reconciler all read it, and every one of them must keep watching a node
   * that is being emptied — that is exactly when its residents move, fail, or
   * strand a container. Use {@link findPlaceable} to pick a home for new work.
   */
  async findEnabled(): Promise<DockerNode[]> {
    return dbRead
      .select()
      .from(dockerNodes)
      .where(and(eq(dockerNodes.enabled, true), currentEnvironmentPredicate()))
      .orderBy(asc(dockerNodes.node_id));
  }

  /**
   * Nodes that may receive NEW placements: enabled and not cordoned.
   *
   * Kept separate from {@link findEnabled} rather than added as a flag,
   * because the two sets diverge exactly when it matters and a boolean
   * argument makes the wrong one a typo away.
   */
  async findPlaceable(): Promise<DockerNode[]> {
    return dbRead
      .select()
      .from(dockerNodes)
      .where(
        and(
          eq(dockerNodes.enabled, true),
          eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
          capacityAttestedPredicate(),
          currentEnvironmentPredicate(),
        ),
      )
      .orderBy(asc(dockerNodes.node_id));
  }

  async findByNodeId(nodeId: string): Promise<DockerNode | null> {
    const [r] = await dbRead
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, nodeId))
      .limit(1);
    return r ?? null;
  }

  async findById(id: string): Promise<DockerNode | null> {
    const [r] = await dbRead.select().from(dockerNodes).where(eq(dockerNodes.id, id)).limit(1);
    return r ?? null;
  }

  /**
   * Find the least-loaded node that is enabled, healthy, and has available capacity.
   * Orders by (capacity - allocated_count) descending, picks the one with most room.
   */
  async findLeastLoaded(): Promise<DockerNode | null> {
    const [r] = await dbRead
      .select()
      .from(dockerNodes)
      .where(
        and(
          eq(dockerNodes.enabled, true),
          eq(dockerNodes.placement_state, PLACEABLE_NODE_STATE),
          eq(dockerNodes.status, "healthy"),
          capacityAttestedPredicate(),
          currentEnvironmentPredicate(),
          sql`${dockerNodes.allocated_count} < ${dockerNodes.capacity}`,
        ),
      )
      .orderBy(sql`(${dockerNodes.capacity} - ${dockerNodes.allocated_count}) DESC`)
      .limit(1);
    return r ?? null;
  }

  // ============================================================================
  // WRITE OPERATIONS
  // ============================================================================

  async create(data: NewDockerNode): Promise<DockerNode> {
    const [r] = await dbWrite.insert(dockerNodes).values(data).returning();
    if (!r) throw new Error("Failed to create docker node record");
    return r;
  }

  async update(id: string, data: Partial<NewDockerNode>): Promise<DockerNode | null> {
    const [r] = await dbWrite
      .update(dockerNodes)
      .set({ ...data, updated_at: new Date() })
      .where(eq(dockerNodes.id, id))
      .returning();
    return r ?? null;
  }

  /**
   * Replace an autoscaler's provisional capacity with its first hardware
   * attestation. The metadata predicate is the exactly-once fence: concurrent
   * or later callbacks cannot consume the marker twice or overwrite a tune.
   */
  async reconcileProvisionalCapacity(
    id: string,
    data: {
      capacity: number;
      hostname: string;
      ssh_port: number;
      ssh_user: string;
      host_key_fingerprint: string;
      status: DockerNodeStatus;
    },
    metadataPatch: Record<string, unknown>,
  ): Promise<DockerNode | null> {
    const patch = JSON.stringify(metadataPatch);
    const [r] = await dbWrite
      .update(dockerNodes)
      .set({
        ...data,
        metadata: sql`(${dockerNodes.metadata} - 'capacityProvisional') || ${patch}::jsonb`,
        updated_at: new Date(),
      })
      .where(
        and(eq(dockerNodes.id, id), sql`${dockerNodes.metadata}->>'capacityProvisional' = 'true'`),
      )
      .returning();
    return r ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const r = await dbWrite
      .delete(dockerNodes)
      .where(eq(dockerNodes.id, id))
      .returning({ id: dockerNodes.id });
    return r.length > 0;
  }

  async updateStatus(nodeId: string, status: DockerNodeStatus): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        status,
        last_health_check: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  /**
   * Mark a node offline AND disable it in one write — used when consecutive
   * health checks confirm it is dead, to route it out of scheduling (`enabled`
   * gates `findEnabled`) while recording why (`status=offline`). An operator
   * re-enables it after remediation.
   */
  async markOfflineAndDisable(nodeId: string): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        status: "offline",
        enabled: false,
        last_health_check: new Date(),
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  async incrementAllocated(nodeId: string): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: sql`${dockerNodes.allocated_count} + 1`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  async decrementAllocated(nodeId: string): Promise<void> {
    const [result] = await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: sql`GREATEST(${dockerNodes.allocated_count} - 1, 0)`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId))
      .returning({ allocated_count: dockerNodes.allocated_count });

    // If allocated_count is 0 after GREATEST clamping, the count was already
    // at 0 before decrement — likely a sync issue worth investigating.
    if (result && result.allocated_count === 0) {
      logger.warn(
        `[docker-nodes] decrementAllocated clamped to 0 for node ${nodeId} — allocation count may be out of sync`,
      );
    }
  }

  /**
   * Persist a host-key fingerprint captured via Trust-On-First-Use.
   *
   * Only writes when the row is still unpinned (`host_key_fingerprint IS NULL`),
   * so it never clobbers an existing pin — a later differing key must surface as
   * a MISMATCH in the SSH verifier, not be silently re-pinned here. Idempotent:
   * concurrent health checks racing to pin the same node all no-op after the
   * first write.
   */
  async setHostKeyFingerprint(nodeId: string, fingerprint: string): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        host_key_fingerprint: fingerprint,
        updated_at: new Date(),
      })
      .where(
        and(eq(dockerNodes.node_id, nodeId), sql`${dockerNodes.host_key_fingerprint} IS NULL`),
      );
  }

  /**
   * Persist the health loop's local-embedding-sidecar verdict into the node's
   * metadata (`metadata.embeddingSidecar = { status, checkedAt }`). A jsonb
   * merge so concurrent writers of other metadata keys (environment stamp,
   * onboard provenance) are never clobbered by the health cycle.
   */
  async setEmbeddingSidecarHealth(
    nodeId: string,
    status: "running" | "unresponsive" | "missing",
  ): Promise<void> {
    const patch = JSON.stringify({
      embeddingSidecar: { status, checkedAt: new Date().toISOString() },
    });
    await dbWrite
      .update(dockerNodes)
      .set({
        metadata: sql`${dockerNodes.metadata} || ${patch}::jsonb`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }

  /**
   * Set allocated_count to an exact value (used during sync).
   */
  async setAllocatedCount(nodeId: string, count: number): Promise<void> {
    await dbWrite
      .update(dockerNodes)
      .set({
        allocated_count: count,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.node_id, nodeId));
  }
}

export const dockerNodesRepository = new DockerNodesRepository();
