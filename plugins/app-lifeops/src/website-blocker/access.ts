import { hasOwnerAccess } from "@elizaos/agent/security/access";
import { type IAgentRuntime, logger, type Memory } from "@elizaos/core";
import { checkSenderRole, type RoleCheckResult } from "./roles.js";

export const SELFCONTROL_ACCESS_ERROR =
  "Website blocking is restricted to OWNER users.";

function hasPrincipal(runtime: IAgentRuntime, message: Memory): boolean {
  return (
    typeof runtime.agentId === "string" &&
    runtime.agentId.length > 0 &&
    typeof message.entityId === "string" &&
    message.entityId.length > 0
  );
}

export async function getSelfControlAccess(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<{
  allowed: boolean;
  role: string | null;
  reason?: string;
}> {
  // Fast path: canonical owner settings and owner-contact metadata are
  // authoritative in environments where the per-world role table is not seeded.
  if (
    hasPrincipal(runtime, message) &&
    (await hasOwnerAccess(runtime, message))
  ) {
    return { allowed: true, role: "OWNER" };
  }

  let roleCheck: RoleCheckResult;
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

  if (!roleCheck.isOwner) {
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
