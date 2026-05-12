import { and, asc, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type DockerNode,
  type DockerNodeStatus,
  dockerNodes,
  type NewDockerNode,
} from "@/db/schemas/docker-nodes";
import { logger } from "@/lib/utils/logger";

export type { DockerNode, DockerNodeStatus, NewDockerNode };

export class DockerNodesRepository {
  // ============================================================================
  // READ OPERATIONS
  // ============================================================================

  async findAll(): Promise<DockerNode[]> {
    return dbRead.select().from(dockerNodes).orderBy(asc(dockerNodes.node_id));
  }

  async findEnabled(): Promise<DockerNode[]> {
    return dbRead
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.enabled, true))
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
          eq(dockerNodes.status, "healthy"),
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
