/**
 * Selfcontrol role checking — delegates to the core @elizaos/core roles module.
 *
 * No fallbacks.  If coreCheckSenderRole returns null the world/room/entity
 * setup is broken and we throw so the caller surfaces a clear error instead
 * of silently hiding the action from the LLM.
 */

import {
  type RoleCheckResult as CoreRoleCheckResult,
  checkSenderRole as coreCheckSenderRole,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";

export type RoleCheckResult = CoreRoleCheckResult;

export async function checkSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckResult> {
  const result = await coreCheckSenderRole(runtime, message);
  if (!result) {
    throw new Error(
      `[selfcontrol] checkSenderRole returned null — world/room/entity setup is broken. ` +
        `roomId=${message.roomId}, entityId=${message.entityId}, agentId=${runtime.agentId}. ` +
        `The room must have a worldId and the sender must be a participant with a resolvable role.`,
    );
  }
  return result;
}
