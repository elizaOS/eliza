import { logger, type IAgentRuntime, type Memory } from "@elizaos/core";
import { hasAdminAccess } from "@elizaos/agent";
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
  // Fast path: the canonical-owner check (ELIZA_ADMIN_ENTITY_ID setting +
  // owner-contacts list) is authoritative for owner/admin access and works
  // in test/benchmark environments where the per-world role table isn't
  // populated. Falls through to the world-role check only when the fast
  // path doesn't recognize the sender.
  if (await hasAdminAccess(runtime, message)) {
    return { allowed: true, role: "OWNER" };
  }

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
