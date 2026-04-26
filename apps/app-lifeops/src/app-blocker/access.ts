import { logger, type IAgentRuntime, type Memory } from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
import { checkSenderRole } from "../website-blocker/roles.ts";

export const APP_BLOCKER_ACCESS_ERROR =
  "App blocking is restricted to OWNER and ADMIN users.";

export async function getAppBlockerAccess(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<{
  allowed: boolean;
  role: string | null;
  reason?: string;
}> {
  // Fast path: canonical-owner check (ELIZA_ADMIN_ENTITY_ID + owner contacts)
  // is authoritative and works in benchmark environments where world-role
  // tables aren't seeded. Falls through to the world-role check otherwise.
  if (await hasAdminAccess(runtime, message)) {
    return { allowed: true, role: "OWNER" };
  }

  let roleCheck;
  try {
    roleCheck = await checkSenderRole(runtime, message);
  } catch (err) {
    logger.error(
      { err, roomId: message.roomId, entityId: message.entityId },
      "[app-blocker] Role check failed — world/room/entity setup is broken",
    );
    return {
      allowed: false,
      role: null,
      reason: `App blocking is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!roleCheck.isAdmin) {
    return {
      allowed: false,
      role: roleCheck.role,
      reason: APP_BLOCKER_ACCESS_ERROR,
    };
  }

  return {
    allowed: true,
    role: roleCheck.role,
  };
}
