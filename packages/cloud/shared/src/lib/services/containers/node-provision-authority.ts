/**
 * Serializes compute-node provisioning per provider and deployment environment.
 * The transaction-scoped advisory lock keeps every API, daemon, and on-demand
 * caller behind the same quota decision while the provider operation is in flight.
 */

import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db/client";
import { dbWrite } from "../../../db/helpers";
import { type DockerNode, dockerNodes, type NewDockerNode } from "../../../db/schemas/docker-nodes";

export interface NodeProvisionAuthority {
  nodes: readonly DockerNode[];
  createNode(data: NewDockerNode): Promise<DockerNode>;
}

async function authorityForTransaction(tx: DbTransaction): Promise<NodeProvisionAuthority> {
  const nodes = await tx.select().from(dockerNodes);
  return {
    nodes,
    async createNode(data) {
      const [created] = await tx.insert(dockerNodes).values(data).returning();
      if (!created) throw new Error("Failed to create docker node record");
      return created;
    },
  };
}

export async function withNodeProvisionAuthority<T>(
  scope: string,
  operation: (authority: NodeProvisionAuthority) => Promise<T>,
): Promise<T> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
        hashtext('eliza:compute-node-provision:v1'),
        hashtext(${scope})
      )`,
    );
    return operation(await authorityForTransaction(tx));
  });
}
