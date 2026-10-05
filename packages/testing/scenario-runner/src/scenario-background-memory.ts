/** Keeps durable post-turn memory inside its originating scenario fixture scope. */
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRuntime, Task } from "@elizaos/core";

const quarantine = new WeakMap<AgentRuntime, string>();

async function pendingMemory(runtime: AgentRuntime): Promise<Task[]> {
  return (await runtime.getTasksByName("POST_TURN_MEMORY")).filter(
    (task) => task.agentId === runtime.agentId,
  );
}

async function abortableRead<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([read(), interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** A shared runtime cannot adopt durable work left by an earlier owner. */
export async function assertScenarioBackgroundMemoryIdle(
  runtime: AgentRuntime,
  signal: AbortSignal,
): Promise<void> {
  const reason = quarantine.get(runtime);
  if (reason) throw new Error(reason);
  if ((await abortableRead(() => pendingMemory(runtime), signal)).length > 0) {
    throw new Error(
      "Runtime has pre-existing post-turn memory work; isolate it before starting another scenario.",
    );
  }
}

/** Wait for the real TaskService timer; never invoke, cancel, or delete its jobs. */
export async function drainScenarioBackgroundMemory(
  runtime: AgentRuntime,
  signal: AbortSignal,
  readDeadline: AbortSignal,
): Promise<void> {
  try {
    // An already-aborted idle drain may still establish that nothing owns
    // this runtime. A new caller abort must interrupt an in-flight read.
    const querySignal = signal.aborted
      ? readDeadline
      : AbortSignal.any([signal, readDeadline]);
    while (true) {
      const tasks = await abortableRead(
        () => pendingMemory(runtime),
        querySignal,
      );
      if (tasks.length === 0) return;
      signal.throwIfAborted();
      if (!runtime.getService("evaluator"))
        throw new Error(
          "Durable memory is pending but its evaluator service is unavailable.",
        );
      for (const task of tasks) {
        if (
          task.metadata?.paused === true ||
          Number(task.metadata?.failureCount ?? 0) > 0
        ) {
          throw new Error(
            `Post-turn memory job ${task.id} is paused or failed; its originating scenario cannot release fixture ownership.`,
          );
        }
      }
      await delay(25, undefined, { signal });
    }
  } catch (error) {
    // error-policy:J2 Retain the failed owner so a later scenario cannot adopt its work.
    const failure = new Error(
      "Scenario post-turn memory did not finish before fixture ownership ended.",
      { cause: error },
    );
    quarantine.set(runtime, failure.message);
    throw failure;
  }
}
