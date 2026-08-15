/**
 * Binds Shared personal-Eliza Todo state to the canonical plugin Postgres
 * store. Logical Shared identities never reach UUID columns directly: this
 * boundary derives stable, server-owned storage scope for both live turns and
 * the exact source snapshot consumed by Dedicated cutover.
 */

import { ElizaError, stringToUuid, type UUID } from "@elizaos/core/edge";
import {
  createTodosSqlStore,
  serializeTodoMutationRecord,
  type Todo,
  type TodoStore,
} from "@elizaos/plugin-todos/edge";
import type { SharedTodoMutationCutoverRecord } from "@elizaos/shared/todo-cutover";
import { dbWrite } from "../../../db/client";

export interface SharedTodoSourceScope {
  sourceAgentId: string;
  ownerId: string;
}

export interface SharedTodoStorageScope {
  agentId: UUID;
  entityId: UUID;
}

export interface SharedTodoCutoverState {
  todos: Todo[];
  mutations: SharedTodoMutationCutoverRecord[];
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
 * Reads the Todo rows and durable mutation ledger from one scope-locked
 * transaction for tier cutover. Storage failures propagate; readable empty
 * state remains two valid empty arrays.
 */
export async function readSharedTodoCutoverState(
  input: SharedTodoSourceScope,
): Promise<SharedTodoCutoverState> {
  const state = await createSharedTodoStore().readCutoverState(sharedTodoStorageScope(input));
  return {
    todos: state.todos,
    mutations: state.mutations.map(serializeTodoMutationRecord),
  };
}
