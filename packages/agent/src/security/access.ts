import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
  checkSenderPrivateAccess,
  hasRoleAccess as coreHasRoleAccess,
} from "@elizaos/core";

/** Role names matching the elizaOS role hierarchy. */
export type RequiredRole = "OWNER" | "ADMIN" | "USER" | "GUEST";

type AccessContext = {
  runtime: IAgentRuntime & { agentId: string };
  message: Memory & { entityId: string };
};

function getAccessContext(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): AccessContext | null {
  if (
    !runtime ||
    typeof runtime.agentId !== "string" ||
    !message ||
    typeof message.entityId !== "string" ||
    message.entityId.length === 0
  ) {
    return null;
  }

  return {
    runtime,
    message,
  };
}

export function isAgentSelf(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): boolean {
  const context = getAccessContext(runtime, message);
  if (!context) {
    return false;
  }
  return context.message.entityId === context.runtime.agentId;
}

export async function hasOwnerAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, "OWNER");
}

export async function hasAdminAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, "ADMIN");
}

export async function hasPrivateAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  if (await coreHasRoleAccess(runtime, message, "OWNER")) {
    return true;
  }

  const context = getAccessContext(runtime, message);
  if (!context) {
    return true;
  }

  try {
    const access = await checkSenderPrivateAccess(
      context.runtime,
      context.message,
    );
    return access?.hasPrivateAccess === true;
  } catch {
    return false;
  }
}

/**
 * Check whether the sender has at least the given role in the elizaOS
 * role hierarchy (OWNER > ADMIN > USER > GUEST).
 *
 * Follows the same lenient pattern as plugin-role-gating: when there is
 * no world context (e.g. local API calls), the check falls through and
 * allows the action so local-only usage isn't blocked.
 */
export async function hasRoleAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
  requiredRole: RequiredRole,
): Promise<boolean> {
  return coreHasRoleAccess(runtime, message, requiredRole);
}
