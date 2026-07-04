// Coordinates cloud service docker port allocation behavior behind route handlers.
import { and, eq, sql } from "drizzle-orm";
import { dbRead } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { containers as containersTable } from "../../db/schemas/containers";
import { logger } from "../utils/logger";
import { allocatePort, readDockerHostPortFromMetadata } from "./docker-sandbox-utils";

/** Ephemeral host port range for app containers (maps container app port). */
export const APP_CONTAINER_HOST_PORT_MIN = 20000;
/** Exclusive upper bound — includes host port 39999. */
export const APP_CONTAINER_HOST_PORT_MAX = 40000;

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

/** Pick a collision-safe host port for an app container on a docker node. */
export async function allocateAppContainerHostPort(nodeId: string): Promise<number> {
  const used = await getUsedDockerHostPorts(nodeId);
  return allocatePort(APP_CONTAINER_HOST_PORT_MIN, APP_CONTAINER_HOST_PORT_MAX, used);
}
