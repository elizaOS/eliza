import type { Todo } from "./types.js";

/**
 * Per-conversation in-memory todo store. Keyed by `conversationId` (the
 * roomId of the message that wrote the list). Lifetimes follow the runtime
 * — restarts wipe the lists.
 *
 * Module-level state is intentional: the todo list is conceptually a single
 * resource per conversation, and keeping it module-scoped lets the action
 * and provider share it without plumbing a service through.
 */
const lists = new Map<string, Todo[]>();

export function setTodos(conversationId: string, todos: Todo[]): Todo[] {
  const previous = lists.get(conversationId) ?? [];
  lists.set(conversationId, todos.slice());
  return previous;
}

export function getTodos(conversationId: string): Todo[] {
  return (lists.get(conversationId) ?? []).slice();
}

export function clearTodos(conversationId: string): void {
  lists.delete(conversationId);
}

export function clearAll(): void {
  lists.clear();
}
