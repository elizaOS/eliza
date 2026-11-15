/**
 * The activity-profile task row is created at boot even before first run
 * completes, so finishing setup in a running process needs no restart. The
 * worker's shouldRun keeps the row a no-op until then. The test stub for
 * `loadElizaConfig` returns no `meta.firstRunComplete`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.ts";
import {
  PROACTIVE_TASK_NAME,
  PROACTIVE_TASK_TAGS,
} from "./proactive-worker.js";

describe("proactive task at boot", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  const previous = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
    if (previous === undefined) {
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    } else {
      process.env.ELIZA_DISABLE_PROACTIVE_AGENT = previous;
    }
  });

  it("creates the task row with first run incomplete, and the worker does not run", async () => {
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "0";
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const task = await vi.waitFor(
      async () => {
        const tasks = await runtime.getTasks({
          agentIds: [runtime.agentId],
          tags: [...PROACTIVE_TASK_TAGS],
        });
        const found = tasks.find((row) => row.name === PROACTIVE_TASK_NAME);
        if (!found) throw new Error("proactive task not created yet");
        return found;
      },
      { timeout: 10_000, interval: 100 },
    );

    const worker = runtime.getTaskWorker(PROACTIVE_TASK_NAME);
    expect(worker?.shouldRun).toBeTypeOf("function");
    expect(await worker?.shouldRun?.(runtime, task)).toBe(false);
  });
});
