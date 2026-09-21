/**
 * CURRENT_TODOS provider injects active todos into task planning context each
 * turn for tasks, todos, and automation conversations.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import { isTodoStore, type TodoStore } from "../store.js";
import { TODOS_CONTEXTS, TODOS_SERVICE_TYPE, type Todo } from "../types.js";

function checkboxFor(status: Todo["status"]): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[→]";
    case "cancelled":
      return "[-]";
    default:
      return "[ ]";
  }
}

/**
 * Surface the user's current todo list to the planner each turn.
 * Returns empty text when the user has no active todos.
 *
 * Scoping: by `entityId` (user) — todos persist across rooms for the same user.
 * Pending + in_progress are always shown; completed/cancelled are excluded.
 */
export interface CurrentTodosProviderOptions {
  resolveStore?: (runtime: IAgentRuntime) => TodoStore | null;
  roleGate?: Provider["roleGate"];
}

function runtimeTodoStore(runtime: IAgentRuntime): TodoStore | null {
  const service = runtime.getService(TODOS_SERVICE_TYPE);
  return isTodoStore(service) ? service : null;
}

export function createCurrentTodosProvider(
  options: CurrentTodosProviderOptions = {},
): Provider {
  const resolveStore = options.resolveStore ?? runtimeTodoStore;
  return {
    name: "CURRENT_TODOS",
    description: "The user's current pending and in-progress todos.",
    position: -5,
    contexts: [...TODOS_CONTEXTS],
    contextGate: { anyOf: [...TODOS_CONTEXTS] },
    // The user's personal todos are member-scoped context — withheld from
    // guest/anonymous callers (#12094 item 3).
    roleGate: options.roleGate ?? { minRole: "USER" },
    get: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
    ): Promise<ProviderResult> => {
      const entityId = message.entityId;
      if (!entityId) return { text: "", data: { todos: [] } };
      const service = resolveStore(runtime);
      if (!service) {
        throw new Error("Todo storage is unavailable for CURRENT_TODOS");
      }
      const todos = await service.list({
        entityId: String(entityId),
        agentId: String(runtime.agentId),
        includeCompleted: false,
      });
      if (todos.length === 0) return { text: "", data: { todos: [] } };
      const lines = [
        "# Current todos",
        "",
        ...todos.map((t) => `- ${checkboxFor(t.status)} ${t.content}`),
      ];
      return {
        text: lines.join("\n"),
        data: { todos },
      };
    },
  };
}

export const currentTodosProvider = createCurrentTodosProvider();
