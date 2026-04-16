import { logger, type IAgentRuntime, type Memory } from "@elizaos/core";
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
