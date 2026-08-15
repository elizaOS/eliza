/**
 * Derives the stable database identities used by one rowless Shared runtime.
 * Live turns, account convergence, and Dedicated cutover share these functions
 * so persisted capability state never depends on a caller-supplied mapping.
 */

import { ElizaError, stringToUuid, type UUID } from "@elizaos/core/edge";

export interface SharedTodoSourceScope {
  sourceAgentId: string;
  ownerId: string;
}

export interface SharedTodoStorageScope {
  agentId: UUID;
  entityId: UUID;
}

function requiredTodoScopePart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ElizaError("Shared Todo storage scope is incomplete", {
      code: "SHARED_TODO_SCOPE_INVALID",
      context: { field },
    });
  }
  return trimmed;
}

function requiredAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ElizaError("Shared runtime agent identity is incomplete", {
      code: "SHARED_RUNTIME_STORAGE_IDENTITY_INVALID",
      context: { field: "agentId" },
    });
  }
  return trimmed;
}

/** Derives the UUID tenant scope under which one Shared user's Todos live. */
export function sharedTodoStorageScope(input: SharedTodoSourceScope): SharedTodoStorageScope {
  const sourceAgentId = requiredTodoScopePart(input.sourceAgentId, "sourceAgentId");
  const ownerId = requiredTodoScopePart(input.ownerId, "ownerId");
  return {
    agentId: stringToUuid(`shared-todos:agent:${sourceAgentId}`),
    entityId: stringToUuid(`shared-todos:owner:${ownerId}`),
  };
}

/** Derives the room visible to genuine Eliza actions in one Shared runtime. */
export function sharedRuntimeConversationRoomId(agentId: string): UUID {
  return stringToUuid(`${requiredAgentId(agentId)}:conversation`);
}

/** Derives the world visible to genuine Eliza actions in one Shared runtime. */
export function sharedRuntimeWorldId(agentId: string): UUID {
  return stringToUuid(`${requiredAgentId(agentId)}:world`);
}
