import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";

const activities = new WeakMap<IAgentRuntime, Map<UUID, Promise<unknown>>>();

/** Keep trigger persistence and execution on the same per-runtime task boundary. */
export async function withTriggerTaskActivity<T>(
  runtime: IAgentRuntime,
  taskId: UUID,
  operation: () => Promise<T>,
  options: { rejectIfBusy?: boolean } = {},
): Promise<T> {
  let tasks = activities.get(runtime);
  if (!tasks) {
    tasks = new Map();
    activities.set(runtime, tasks);
  }
  const prior = tasks.get(taskId);
  if (prior && options.rejectIfBusy) {
    throw new ElizaError("The automation is still running", {
      code: "TRIGGER_TASK_BUSY",
      severity: "ephemeral",
    });
  }
  // Each caller receives its own failure. It does not poison the next operation.
  const pending = (
    prior ? prior.catch(() => undefined) : Promise.resolve()
  ).then(operation);
  tasks.set(taskId, pending);
  try {
    return await pending;
  } finally {
    if (tasks.get(taskId) === pending) tasks.delete(taskId);
    if (tasks.size === 0) activities.delete(runtime);
  }
}
