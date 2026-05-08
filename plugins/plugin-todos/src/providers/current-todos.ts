import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";

import { TodosService } from "../service.js";
import {
  type Todo,
  TODOS_CONTEXTS,
  TODOS_SERVICE_TYPE,
} from "../types.js";

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
 * Mirrors how Claude Code keeps the TodoWrite list in the model's context.
 * Returns empty text when the user has no active todos.
 *
 * Scoping: by `entityId` (user) — todos persist across rooms for the same user.
 * Pending + in_progress are always shown; completed/cancelled are excluded.
 */
export const currentTodosProvider: Provider = {
  name: "CURRENT_TODOS",
  description: "The user's current pending and in-progress todos.",
  position: -5,
  contexts: [...TODOS_CONTEXTS],
  contextGate: { anyOf: [...TODOS_CONTEXTS] },
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const entityId = message.entityId;
    if (!entityId) return { text: "", data: { todos: [] } };
    const service = runtime.getService<TodosService>(TODOS_SERVICE_TYPE);
    if (!service) return { text: "", data: { todos: [] } };
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
