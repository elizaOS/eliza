/**
 * Persists explicit node retirement independently of capacity selection.
 * Provider failure must leave the committed request discoverable. The node row
 * lock serializes retirement with node mutations. Workload admission must persist
 * its ownership before remote effects; a node lock alone cannot establish that.
 */

import { ElizaError } from "@elizaos/core";
import { and, eq, sql } from "drizzle-orm";
import { dbWrite } from "../../../db/helpers";
import {
  type DockerNode,
  dockerNodes,
  NODE_RETIREMENT_METADATA_KEY,
} from "../../../db/schemas/docker-nodes";
import { containersEnv } from "../../config/containers-env";
import { requireHetznerNodeAuthority } from "./hetzner-node-attestation";

const RETIREMENT_KEY = NODE_RETIREMENT_METADATA_KEY;

/** Only a request for this exact typed provider identity permits automatic retry. */
export function hasNodeRetirementRequest(node: DockerNode): boolean {
  return (
    !node.enabled &&
    node.fleet_kind === "cloud" &&
    node.infrastructure_provider === "hetzner" &&
    node.provider_server_id !== null &&
    node.metadata[RETIREMENT_KEY] === node.provider_server_id
  );
}

/** Commit the request before starting any fallible provider operation. */
export async function requestNodeRetirement(nodeId: string): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, nodeId))
      .for("update");
    if (!node) {
      throw new ElizaError("Cannot retire an unregistered Docker node", {
        code: "NODE_RETIREMENT_NOT_FOUND",
        context: { nodeId },
      });
    }
    requireHetznerNodeAuthority(node);
    const patch = JSON.stringify({ [RETIREMENT_KEY]: node.provider_server_id });
    await tx
      .update(dockerNodes)
      .set({
        enabled: false,
        placement_state: "cordoned",
        metadata: sql`${dockerNodes.metadata} || ${patch}::jsonb`,
        updated_at: new Date(),
      })
      .where(eq(dockerNodes.id, node.id));
  });
}

/** Read retirement intent from the primary; replica lag cannot hide failed cleanup. */
export async function findRequestedNodeRetirements(): Promise<DockerNode[]> {
  return dbWrite
    .select()
    .from(dockerNodes)
    .where(
      and(
        eq(dockerNodes.enabled, false),
        eq(dockerNodes.fleet_kind, "cloud"),
        eq(dockerNodes.infrastructure_provider, "hetzner"),
        sql`${dockerNodes.metadata}->>'environment' = ${containersEnv.environment()}`,
        sql`${dockerNodes.metadata}->>${RETIREMENT_KEY} = ${dockerNodes.provider_server_id}`,
      ),
    )
    .orderBy(dockerNodes.updated_at);
}

/** The callback returns true only after retained-workload checks and provider absence proof. */
export async function withNodeRetirementAuthority(
  nodeId: string,
  retire: (node: DockerNode) => Promise<boolean>,
): Promise<boolean> {
  return dbWrite.transaction(async (tx) => {
    const [node] = await tx
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.node_id, nodeId))
      .for("update");
    if (!node) return true;
    if (!hasNodeRetirementRequest(node)) {
      throw new ElizaError("Docker node has no matching retirement request", {
        code: "NODE_RETIREMENT_AUTHORITY_CHANGED",
        context: { nodeId },
      });
    }
    requireHetznerNodeAuthority(node);
    if (!(await retire(node))) return false;
    await tx.delete(dockerNodes).where(eq(dockerNodes.id, node.id));
    return true;
  });
}
