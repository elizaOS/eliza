/**
 * Projects caller-requested A2A v0.3 task history without changing stored tasks.
 * Zero and omitted counts retain the existing unlimited-history contract.
 */
import type { Task } from "../../types/a2a";

export function projectTaskHistory(task: Task, historyLength?: number): Task {
  return {
    ...task,
    ...(task.history
      ? { history: historyLength ? task.history.slice(-historyLength) : [...task.history] }
      : {}),
  };
}
