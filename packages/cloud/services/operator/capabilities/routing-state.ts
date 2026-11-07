/** Validates routing write receipts and releases only routes still owned by a server. */
import {
  type OwnershipRedis,
  removeOwnedRedisKeys,
  requireRedisWriteReceipts,
} from "@elizaos/cloud-services-common/redis-ownership";
export class OperatorRoutingError extends Error {
  readonly code = "OPERATOR_ROUTING_WRITE_FAILED";
}

export function requireRoutingWriteReceipts(
  receipts: unknown,
  expected: number,
): void {
  requireRedisWriteReceipts(
    receipts,
    expected,
    "routing",
    (message, cause) => new OperatorRoutingError(message, { cause }),
  );
}

/** A delayed old-owner cleanup must not delete a newer server's assignment. */
export async function removeOwnedAgentRoutes(
  redis: OwnershipRedis,
  serverName: string,
  agentIds: readonly string[],
): Promise<void> {
  await removeOwnedRedisKeys(
    redis,
    serverName,
    agentIds.map((id) => `agent:${id}:server`),
  );
}
