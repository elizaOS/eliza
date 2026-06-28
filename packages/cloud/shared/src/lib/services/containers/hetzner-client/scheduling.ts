/**
 * Node-selection helpers for createContainer.
 *
 * "Sticky" pinning to a node that already hosts a project's volume,
 * Hetzner-Cloud-location matching, and DockerNode introspection live
 * here so the createContainer flow reads as policy, not SQL.
 */

import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "../../../../db/client";
import { dockerNodesRepository } from "../../../../db/repositories/docker-nodes";
import { containers as containersTable } from "../../../../db/schemas/containers";
import type { DockerNode } from "../../../../db/schemas/docker-nodes";
import { dockerNodes as dockerNodesTable } from "../../../../db/schemas/docker-nodes";

/**
 * Look up the node that already hosts a persistent volume for this
 * project. Used to pin redeploys to the same node so stateful agents
 * keep their data. Returns null when no prior container in this
 * project has a volume, or when the prior node is offline / disabled /
 * full.
 */
export async function findStickyNodeForProject(
  organizationId: string,
  projectName: string,
): Promise<DockerNode | null> {
  const [row] = await dbRead
    .select({ node_id: containersTable.node_id })
    .from(containersTable)
    .where(
      and(
        eq(containersTable.organization_id, organizationId),
        eq(containersTable.project_name, projectName),
        sql`${containersTable.node_id} is not null`,
        sql`${containersTable.volume_path} is not null`,
        sql`${containersTable.status} not in ('failed','deleted')`,
      ),
    )
    .orderBy(sql`${containersTable.created_at} desc`)
    .limit(1);

  if (!row?.node_id) return null;

  const node = await dockerNodesRepository.findByNodeId(row.node_id);
  if (!node || !node.enabled || node.status !== "healthy") return null;
  if (node.allocated_count >= node.capacity) return null;

  return node;
}

/**
 * Find the least-loaded healthy node whose Hetzner Cloud location matches
 * `location`. Only Cloud-provisioned nodes carry `metadata.location`; manually
 * registered auctioned/dedicated nodes will not appear in these results.
 */
export async function findNodeInLocation(location: string): Promise<DockerNode | null> {
  const [r] = await dbRead
    .select()
    .from(dockerNodesTable)
    .where(
      and(
        eq(dockerNodesTable.enabled, true),
        eq(dockerNodesTable.status, "healthy"),
        sql`${dockerNodesTable.allocated_count} < ${dockerNodesTable.capacity}`,
        sql`${dockerNodesTable.metadata}->>'location' = ${location}`,
      ),
    )
    .orderBy(sql`(${dockerNodesTable.capacity} - ${dockerNodesTable.allocated_count}) DESC`)
    .limit(1);
  return r ?? null;
}

export function getDockerNodeLocation(node: DockerNode): string | null {
  const location = node.metadata.location;
  return typeof location === "string" ? location : null;
}
