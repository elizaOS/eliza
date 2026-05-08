import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  messageAction,
  resolveCanonicalOwnerIdForMessage,
  stringToUuid,
} from "@elizaos/core";

/**
 * Compatibility helper used by agent-side inbox/admin flows.
 *
 * Sending is handled by the polymorphic MESSAGE action (op=send) in
 * @elizaos/core. This helper just resolves the owner's client-chat entity
 * so callers can target it.
 */
export async function resolveAdminEntityId(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<UUID> {
  const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
  if (ownerId) {
    return ownerId as UUID;
  }

  const agentName = runtime.character?.name ?? runtime.agentId;
  return stringToUuid(`${agentName}-admin-entity`) as UUID;
}

export { messageAction };
export default messageAction;
