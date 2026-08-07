/**
 * Daemon-phase test for the warm-pool REPLENISH cycle wiring.
 *
 * `WarmPoolManager.replenish()` had no live caller (the only historical one was
 * the deprecated container-control-plane service; the CF cron stub only claimed
 * the daemon owned it). This proves the daemon now actually drives replenish
 * through `processPoolReplenishCycle`, and that it stays error-isolated so a bad
 * node can't wedge the rest of the maintenance cycle. See
 * PROVISIONING-E2E-AUDIT §C4. [sol-cloud]
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __setDepsForTests,
  processPoolReplenishCycle,
} from "./provisioning-worker";

/**
 * A real-shaped WarmPoolManager stand-in whose `replenish` is a mock, so the
 * daemon phase's call + summary mapping is what's under test (the real manager's
 * replenish I/O is pinned in agent-warm-pool.replenish.test.ts).
 */
function fakeDeps(replenishImpl: (image: string) => Promise<unknown>) {
  const replenish = mock(replenishImpl);
  class FakeManager {
    replenish(image: string) {
      return replenish(image);
    }
    // drainIdle exists so getWarmPoolManager's construction shape is satisfied.
    drainIdle() {
      return Promise.resolve({
        decision: { toDrain: [], reason: "" },
        drained: [],
        failed: [],
      });
    }
  }
  const deps = {
    containersEnv: { defaultAgentImage: () => "img:tag" },
    WarmPoolManager: FakeManager,
    getHetznerPoolContainerCreator: () => ({}),
  } as unknown as Parameters<typeof __setDepsForTests>[0];
  return { deps, replenish };
}

afterEach(() => {
  __setDepsForTests(null);
});

describe("processPoolReplenishCycle (daemon phase wiring)", () => {
  test("drives WarmPoolManager.replenish with the current image and maps the summary", async () => {
    const { deps, replenish } = fakeDeps(async () => ({
      decision: { toCreate: 2, reason: "total 0 < target 2; creating 2" },
      state: {},
      created: [
        { id: "a", nodeId: "n1" },
        { id: "b", nodeId: "n2" },
      ],
      failed: [],
    }));
    __setDepsForTests(deps);

    const summary = await processPoolReplenishCycle();

    expect(replenish).toHaveBeenCalledTimes(1);
    expect(replenish).toHaveBeenCalledWith("img:tag");
    expect(summary.created).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.reason).toContain("creating 2");
  });

  test("reports failed creates in the summary (burst hit a bad node)", async () => {
    const { deps } = fakeDeps(async () => ({
      decision: { toCreate: 1, reason: "creating 1" },
      state: {},
      created: [],
      failed: [{ error: "no space left on device" }],
    }));
    __setDepsForTests(deps);

    const summary = await processPoolReplenishCycle();

    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(1);
  });

  test("when disabled, replenish is a no-op decision and the phase reports 0/0", async () => {
    const { deps } = fakeDeps(async () => ({
      decision: { toCreate: 0, reason: "WARM_POOL_ENABLED=false (no-op)" },
      state: {},
      created: [],
      failed: [],
    }));
    __setDepsForTests(deps);

    const summary = await processPoolReplenishCycle();

    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.reason).toContain("WARM_POOL_ENABLED=false");
  });
});
