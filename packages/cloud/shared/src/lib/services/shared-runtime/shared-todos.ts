/**
 * Binds Shared personal-Eliza Todo state to the canonical plugin Postgres
 * store. Logical Shared identities never reach UUID columns directly: this
 * boundary derives stable, server-owned storage scope for both live turns and
 * the exact source snapshot consumed by Dedicated cutover.
 */

import { ElizaError, stringToUuid, type UUID } from "@elizaos/core/edge";
import { createTodosSqlStore, type Todo, type TodoStore } from "@elizaos/plugin-todos/edge";
import { dbWrite } from "../../../db/client";

export interface SharedTodoSourceScope {
  sourceAgentId: string;
  ownerId: string;
}

export interface SharedTodoStorageScope {
  agentId: UUID;
  entityId: UUID;
}

function requireScopePart(value: string, field: keyof SharedTodoSourceScope): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ElizaError("Shared Todo storage scope is incomplete", {
      code: "SHARED_TODO_SCOPE_INVALID",
      context: { field },
    });
  }
  return trimmed;
}

/** Derives the only UUID scope under which one Shared user's Todos are stored. */
export function sharedTodoStorageScope(input: SharedTodoSourceScope): SharedTodoStorageScope {
  const sourceAgentId = requireScopePart(input.sourceAgentId, "sourceAgentId");
  const ownerId = requireScopePart(input.ownerId, "ownerId");
  return {
    agentId: stringToUuid(`shared-todos:agent:${sourceAgentId}`),
    entityId: stringToUuid(`shared-todos:owner:${ownerId}`),
  };
}

/** Creates the canonical TodoStore over Cloud's request-scoped Hyperdrive DB. */
export function createSharedTodoStore(): TodoStore {
  return createTodosSqlStore(dbWrite);
}

/**
 * Returns every canonical source Todo in stable order for an atomic tier
 * cutover. Storage failures propagate; only a readable empty source is `[]`.
 */
export async function listSharedTodosSnapshot(input: SharedTodoSourceScope): Promise<Todo[]> {
  const scope = sharedTodoStorageScope(input);
  const todos = await createSharedTodoStore().list({
    ...scope,
    status: ["pending", "in_progress", "completed", "cancelled"],
  });
  return [...todos].sort((left, right) => left.id.localeCompare(right.id));
}
