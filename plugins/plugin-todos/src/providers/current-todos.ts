import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { getTodos } from "../store.js";
import { type Todo, TODOS_CONTEXTS } from "../types.js";

function checkboxFor(status: Todo["status"]): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[→]";
    default:
      return "[ ]";
  }
}

/**
 * Surface the conversation's current todo list to the planner each turn.
 * Mirrors how Claude Code keeps the TodoWrite list in the model's context.
 * No-ops (returns empty text) if the conversation has no todos.
 */
export const currentTodosProvider: Provider = {
  name: "CURRENT_TODOS",
  description:
    "The conversation's current todo list, written by TODO_WRITE.",
  position: -5,
  contexts: [...TODOS_CONTEXTS],
  contextGate: { anyOf: [...TODOS_CONTEXTS] },
  get: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    if (!message.roomId) return { text: "", data: { todos: [] } };
    const conversationId = String(message.roomId);
    const todos = getTodos(conversationId);
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
