import type { IAgentRuntime, Memory } from "@elizaos/core";
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
  const roleCheck = await checkSenderRole(runtime, message);
  if (!roleCheck?.isAdmin) {
    return {
      allowed: false,
      role: roleCheck?.role ?? null,
      reason: SELFCONTROL_ACCESS_ERROR,
    };
  }

  return {
    allowed: true,
    role: roleCheck.role,
  };
}
