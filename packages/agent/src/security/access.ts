import type { IAgentRuntime, Memory, RoleName } from "@elizaos/core";
import {
  checkSenderPrivateAccess,
  hasRoleAccess as coreHasRoleAccess,
} from "@elizaos/core";

/**
 * Role names matching the elizaOS role hierarchy. #12087 Item 28: aliases the
 * canonical core union instead of re-declaring the string literals, so the two
 * cannot drift.
 */
export type RequiredRole = RoleName;

/**
 * Re-export the single core role primitive. This module no longer defines its
 * own `hasRoleAccess`: the previous local copy was a pure pass-through to the
 * core implementation, so a second symbol only invited drift between two
 * authorization seams (#9947). Callers get the canonical
 * `hasRoleAccess(runtime, message, requiredRole)` from `@elizaos/core`.
 */
export { hasRoleAccess } from "@elizaos/core";

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
    // Fail closed: a missing/invalid world context must deny private access,
    // never grant it.
    return false;
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
