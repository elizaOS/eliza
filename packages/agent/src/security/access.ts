import type { IAgentRuntime, Memory, RoleName } from "@elizaos/core";
import { checkSenderPrivateAccess, hasRoleAccess } from "@elizaos/core";

/**
 * The canonical elizaOS role gate (OWNER > ADMIN > USER > GUEST), re-exported
 * from @elizaos/core so agent code shares one implementation. When there is no
 * world context (e.g. local API calls) it allows through, matching plugin role
 * gating. Do not duplicate the rank logic here.
 */
export { hasRoleAccess };

/** Alias of the canonical {@link RoleName} from @elizaos/core. */
export type RequiredRole = RoleName;

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
  return hasRoleAccess(runtime, message, "OWNER");
}

export async function hasAdminAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  return hasRoleAccess(runtime, message, "ADMIN");
}

export async function hasPrivateAccess(
  runtime: IAgentRuntime | undefined,
  message: Memory | undefined,
): Promise<boolean> {
  if (await hasRoleAccess(runtime, message, "OWNER")) {
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
