/**
 * Shared helper for the trust capability that decides whether a message sender
 * should be treated as trusted-admin context: true when they match the
 * configured OWNER_ENTITY_ID or when core's role resolution (hasAdminAccess)
 * grants them ADMIN or OWNER. Consumed by the securityStatus provider to bypass
 * adversarial-input gating for admins.
 */
import {
  hasAdminAccess,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

export async function resolveAdminContext(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
): Promise<boolean> {
  const ownerEntityId = runtime.getSetting("OWNER_ENTITY_ID");
  if (ownerEntityId && message.entityId === ownerEntityId) {
    return true;
  }

  // The securityStatus provider's ADMIN role gate admits senders through core's
  // role resolution (world ownership, ELIZA_ADMIN_ENTITY_ID, connector and
  // linked identities) in every room type, including the app's direct chat.
  // Use the same resolution here, so this helper agrees with that gate.
  return hasAdminAccess(runtime, message);
}
