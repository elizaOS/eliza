import { logger, type IAgentRuntime, type Memory } from "@elizaos/core";
import { checkSenderRole } from "./roles.ts";

export const SELFCONTROL_ACCESS_ERROR =
  "Website blocking is restricted to OWNER and ADMIN users.";

export async function getSelfControlAccess(
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
    // checkSenderRole throws when the world/room/entity setup is broken.
    // Log loudly so the root cause gets fixed, but don't crash the whole
    // action-validation pass (Promise.all in the actions provider would
    // reject and kill every action, not just this one).
    logger.error(
      { err, roomId: message.roomId, entityId: message.entityId },
      "[selfcontrol] Role check failed — world/room/entity setup is broken",
    );
    return {
      allowed: false,
      role: null,
      reason: `Website blocking is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!roleCheck.isAdmin) {
    return {
      allowed: false,
      role: roleCheck.role,
      reason: SELFCONTROL_ACCESS_ERROR,
    };
  }

  return {
    allowed: true,
    role: roleCheck.role,
  };
}
