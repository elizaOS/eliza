/**
 * Binds Shared personal-Eliza Todo state to the canonical plugin Postgres
 * store. Logical Shared identities never reach UUID columns directly: this
 * boundary derives stable, server-owned storage scope for both live turns and
 * the exact source snapshot consumed by Dedicated cutover.
 */
import { createTodosSqlStore } from "@elizaos/plugin-todos/edge";
import { dbWrite } from "../../../db/client";
import { serializeTodoMutationRecord } from "@elizaos/plugin-todos/edge";
import { sharedTodoStorageScope } from "./shared-runtime-storage-identity";
import { type SharedTodoMutationCutoverRecord } from "@elizaos/shared";
import { type SharedTodoSourceScope } from "./shared-runtime-storage-identity";
import { type Todo } from "@elizaos/plugin-todos/edge";
import { type TodoStore } from "@elizaos/plugin-todos/edge";
export { type SharedTodoSourceScope, type SharedTodoStorageScope, sharedRuntimeConversationRoomId, sharedRuntimeWorldId, sharedTodoStorageScope, } from "./shared-runtime-storage-identity";
export interface SharedTodoCutoverState {
    todos: Todo[];
    mutations: SharedTodoMutationCutoverRecord[];
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
export async function readSharedTodoCutoverState(input: SharedTodoSourceScope): Promise<SharedTodoCutoverState> {
    const state = await createSharedTodoStore().readCutoverState(sharedTodoStorageScope(input));
    return {
        todos: state.todos,
        mutations: state.mutations.map(serializeTodoMutationRecord),
    };
}
