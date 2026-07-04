/**
 * Role and access checks for agent-side authorization: owner, admin, and
 * private-channel access plus agent-self detection. Every decision delegates to
 * `@elizaos/core`'s role primitives (`hasRoleAccess`, `checkSenderPrivateAccess`)
 * so the agent never grows a second authorization seam that could drift from the
 * core role hierarchy; missing or invalid context fails closed (denies access).
 */
import type { IAgentRuntime, Memory, RoleName } from "@elizaos/core";
import {
  checkSenderPrivateAccess,
  hasRoleAccess as coreHasRoleAccess,
} from "@elizaos/core";

/**
 * Alias of the canonical core `RoleName` union, so agent-side role checks cannot
 * drift from the core role hierarchy.
 */
export type RequiredRole = RoleName;

/**
 * Re-exports the single core `hasRoleAccess(runtime, message, requiredRole)`
 * primitive. The agent keeps no local copy, so a second symbol cannot invite
 * drift between two authorization seams (#9947).
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
