/**
 * Register the todos view for terminal rendering.
 *
 * The agent terminal mounts plugin views by id from the `@elizaos/tui` terminal
 * registry. This makes the todos `tui` modality render for real in the terminal
 * (the unified {@link TodosSpatialView}) rather than only navigating a GUI
 * shell. A module-level snapshot lets a host push live board data; absent a
 * push it defaults to the loading state.
 */

import { registerSpatialTerminalView } from "@elizaos/ui/spatial/tui";
import { createElement } from "react";
import {
  EMPTY_LANES,
  type TodosSnapshot,
  TodosSpatialView,
} from "./components/todos/TodosSpatialView.tsx";

const EMPTY: TodosSnapshot = {
  state: "loading",
  lanes: EMPTY_LANES,
  overdue: 0,
};
let current: TodosSnapshot = EMPTY;

/** Update the snapshot the registered terminal view renders from. */
export function setTodosTerminalSnapshot(next: TodosSnapshot): void {
  current = next;
}

/** Register the todos terminal view; returns an unregister function. */
export function registerTodosTerminalView(): () => void {
  return registerSpatialTerminalView("todos", () =>
    createElement(TodosSpatialView, { snapshot: current }),
  );
}
