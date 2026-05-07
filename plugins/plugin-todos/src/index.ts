import type { Plugin } from "@elizaos/core";
import { todoWriteAction } from "./actions/todo-write.js";
import { currentTodosProvider } from "./providers/current-todos.js";

export const todosPlugin: Plugin = {
  name: "todos",
  description:
    "TODO_WRITE action and currentTodosProvider. Per-conversation in-memory todo list, mirroring Claude Code's TodoWrite tool. The provider surfaces the current list to the planner each turn so the model always sees outstanding work without re-querying.",
  actions: [todoWriteAction],
  providers: [currentTodosProvider],
};

export default todosPlugin;

export { todoWriteAction } from "./actions/todo-write.js";
export { currentTodosProvider } from "./providers/current-todos.js";
export {
  clearAll,
  clearTodos,
  getTodos,
  setTodos,
} from "./store.js";
export * from "./types.js";
