import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { containers as containersTable } from "@/db/schemas/containers";
import { logger } from "@/lib/utils/logger";
import { readDockerHostPortFromMetadata } from "./docker-sandbox-utils";

/**
 * Return Docker host ports already allocated on a node across both control
 * planes that share the same Docker pool: system-managed agent sandboxes and
 * user-deployed app containers.
 */
export async function getUsedDockerHostPorts(nodeId: string): Promise<Set<number>> {
  const used = new Set<number>();

  try {
    const sandboxes = await agentSandboxesRepository.listByNodeId(nodeId);
    for (const sandbox of sandboxes) {
      if (sandbox.bridge_port) used.add(sandbox.bridge_port);
      if (sandbox.web_ui_port) used.add(sandbox.web_ui_port);
    }
  } catch (error) {
    logger.warn(
      `[docker-port-allocation] Failed to query sandbox ports for node ${nodeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const rows = await dbRead
      .select({ metadata: containersTable.metadata })
      .from(containersTable)
      .where(
        and(
          eq(containersTable.node_id, nodeId),
          sql`${containersTable.status} not in ('failed','stopped','deleted')`,
        ),
      );

    for (const row of rows) {
      const hostPort = readDockerHostPortFromMetadata(row.metadata);
      if (hostPort !== null) used.add(hostPort);
    }
  } catch (error) {
    logger.warn(
      `[docker-port-allocation] Failed to query app container ports for node ${nodeId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return used;
}
