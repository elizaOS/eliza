/**
 * Selfcontrol role checking — delegates to the core @elizaos/core roles module.
 *
 * Previously this was a full reimplementation that diverged from core,
 * missing world-resolution fallbacks and silently swallowing errors.
 * Now it's a thin adapter that re-exports the core checkSenderRole
 * with the extra `hasPrivateAccess` field for backward compatibility.
 *
 * When the core module returns null (no world found for the message),
 * we fall back to checking whether the sender matches the configured
 * admin entity ID. This covers dashboard/terminal sessions where the
 * world may not exist yet or the room has no worldId.
 */

import {
  checkSenderRole as coreCheckSenderRole,
  logger,
  resolveCanonicalOwnerId,
  type IAgentRuntime,
  type Memory,
  type RoleCheckResult as CoreRoleCheckResult,
  type UUID,
} from "@elizaos/core";

export type RoleCheckResult = CoreRoleCheckResult & {
  hasPrivateAccess: boolean;
};

export async function checkSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckResult | null> {
  const result = await coreCheckSenderRole(runtime, message);
  if (result) {
    return {
      ...result,
      hasPrivateAccess: result.isAdmin,
    };
  }

  // Fallback: no world found for this message's room. This happens for
  // dashboard/terminal sessions where the world may not be set up yet.
  // If the sender matches the configured canonical owner, grant OWNER.
  const canonicalOwnerId = resolveCanonicalOwnerId(runtime);
  const senderEntityId = String(message.entityId);

  if (canonicalOwnerId && senderEntityId === canonicalOwnerId) {
    logger.debug(
      "[selfcontrol] No world for message room, but sender matches configured admin entity — granting OWNER",
    );
    return {
      entityId: senderEntityId as UUID,
      role: "OWNER",
      isOwner: true,
      isAdmin: true,
      canManageRoles: true,
      hasPrivateAccess: true,
    };
  }

  logger.debug(
    "[selfcontrol] checkSenderRole returned null — no world found and sender does not match configured admin entity",
  );
  return null;
}
