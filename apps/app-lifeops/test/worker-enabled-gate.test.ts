/**
 * Tests that the three lifeops task workers respect the `enabled` flag
 * stored in the runtime cache (via `loadLifeOpsAppState`). When LifeOps
 * is disabled via the UI toggle, each worker's `shouldRun` returns false
 * so the scheduler tick becomes a cheap no-op.
 *
 * When the cache is unreachable or throws, the workers fall back to
 * running (failing open so a transient cache issue doesn't halt LifeOps).
 */

import type { IAgentRuntime, TaskWorker } from "@elizaos/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerProactiveTaskWorker } from "../src/activity-profile/proactive-worker.js";
import { registerFollowupTrackerWorker } from "../src/followup/followup-tracker.js";
import { registerLifeOpsTaskWorker } from "../src/lifeops/runtime.js";

const APP_STATE_CACHE_KEY = "eliza:lifeops-app-state";

type RegisterFn = (runtime: IAgentRuntime) => void;

interface MakeRuntimeOpts {
  cacheValue?: { enabled: boolean } | null;
  cacheError?: string;
}

function makeRuntime(opts: MakeRuntimeOpts = {}) {
  let registered: TaskWorker | null = null;
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000003",
    getTaskWorker: vi.fn(() => undefined),
    registerTaskWorker: vi.fn((worker: TaskWorker) => {
      registered = worker;
    }),
    getCache: vi.fn(async (key: string) => {
      if (key !== APP_STATE_CACHE_KEY) return undefined;
      if (opts.cacheError) throw new Error(opts.cacheError);
      return opts.cacheValue ?? undefined;
    }),
    setCache: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;

  return {
    runtime,
    getRegistered: () => {
      if (!registered) {
        throw new Error("task worker was not registered");
      }
      return registered;
    },
  };
}

/**
 * Run the four-case `shouldRun` contract against a given register function.
 * Each worker must behave identically with respect to the enabled flag.
 */
function describeSharedShouldRunContract(
  label: string,
  register: RegisterFn,
): void {
  describe(label, () => {
    test("shouldRun returns false when cache reports enabled: false", async () => {
      const { runtime, getRegistered } = makeRuntime({
        cacheValue: { enabled: false },
      });
      register(runtime);
      const worker = getRegistered();
      await expect(worker.shouldRun?.(runtime)).resolves.toBe(false);
    });

    test("shouldRun returns true when cache reports enabled: true", async () => {
      const { runtime, getRegistered } = makeRuntime({
        cacheValue: { enabled: true },
      });
      register(runtime);
      const worker = getRegistered();
      await expect(worker.shouldRun?.(runtime)).resolves.toBe(true);
    });

    test("shouldRun returns true when cache is missing (defaults to enabled)", async () => {
      const { runtime, getRegistered } = makeRuntime({
        cacheValue: null,
      });
      register(runtime);
      const worker = getRegistered();
      await expect(worker.shouldRun?.(runtime)).resolves.toBe(true);
    });

    test("shouldRun fails open to true when getCache throws", async () => {
      const { runtime, getRegistered } = makeRuntime({
        cacheError: "boom",
      });
      register(runtime);
      const worker = getRegistered();
      await expect(worker.shouldRun?.(runtime)).resolves.toBe(true);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describeSharedShouldRunContract(
  "registerLifeOpsTaskWorker (scheduler)",
  registerLifeOpsTaskWorker,
);
describeSharedShouldRunContract(
  "registerProactiveTaskWorker (proactive agent)",
  registerProactiveTaskWorker,
);
describeSharedShouldRunContract(
  "registerFollowupTrackerWorker (follow-up reconciler)",
  registerFollowupTrackerWorker,
);
