import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  resolveCanonicalOwnerIdForMessage,
  sendMessageAction,
  stringToUuid,
} from "@elizaos/core";

/**
 * Compatibility helper used by agent-side inbox/admin flows.
 *
 * The SEND_MESSAGE action itself is defined in @elizaos/core so there is only
 * one routed send implementation. Keep this helper exported for existing
 * imports that need to resolve the owner's client-chat entity.
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

export { sendMessageAction };
export default sendMessageAction;
