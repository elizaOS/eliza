/**
 * Verifies the daemon phase that drives ready warm-pool health checks.
 *
 * Ready pool rows are outside both the shared-tier heartbeat sweep and the
 * unclaimable-row reconciler. The manager's probe and teardown behavior is
 * covered separately; this suite pins the daemon call, summary mapping, error
 * propagation, and ordering before replenishment.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_WARM_POOL_POLICY } from "@elizaos/cloud-shared/lib/services/containers/agent-warm-pool-forecast";
import {
  __setDepsForTests,
  processPoolHealthCheckCycle,
} from "./provisioning-worker";

type HealthCheckResultShape = {
  probed: number;
  alive: number;
  reconciliation: Record<string, unknown>;
  removed: Array<{ id: string; reason: string }>;
};

/**
 * A real-shaped WarmPoolManager stand-in whose `healthCheck` is a mock, so the
 * daemon phase's call and summary mapping is what is exercised.
 */
function fakeDeps(healthCheckImpl: () => Promise<HealthCheckResultShape>) {
  const healthCheck = mock(healthCheckImpl);
  const calls: string[] = [];
  class FakeManager {
    healthCheck() {
      calls.push("healthCheck");
      return healthCheck();
    }
    replenish() {
      calls.push("replenish");
      return Promise.resolve({
        decision: { toCreate: 0, reason: "" },
        state: {},
        created: [],
        failed: [],
      });
    }
    drainIdle() {
      calls.push("drainIdle");
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
    envWarmPoolPolicy: () => DEFAULT_WARM_POOL_POLICY,
    getHetznerPoolContainerCreator: () => ({}),
  } as unknown as Parameters<typeof __setDepsForTests>[0];
  return { deps, healthCheck, calls };
}

afterEach(() => {
  __setDepsForTests(null);
});

describe("processPoolHealthCheckCycle (daemon phase wiring)", () => {
  test("drives WarmPoolManager.healthCheck and maps the collected count", async () => {
    const { deps, healthCheck } = fakeDeps(async () => ({
      probed: 5,
      alive: 3,
      reconciliation: {},
      removed: [
        { id: "dead-1", reason: "health probe failed" },
        { id: "dead-2", reason: "health probe failed" },
      ],
    }));
    __setDepsForTests(deps);

    const summary = await processPoolHealthCheckCycle();

    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ probed: 5, alive: 3, removed: 2 });
  });

  test("reports zero collected when every ready entry answers its probe", async () => {
    const { deps } = fakeDeps(async () => ({
      probed: 4,
      alive: 4,
      reconciliation: {},
      removed: [],
    }));
    __setDepsForTests(deps);

    expect(await processPoolHealthCheckCycle()).toEqual({
      probed: 4,
      alive: 4,
      removed: 0,
    });
  });

  test("lets a probe failure propagate rather than reporting a healthy pool", async () => {
    // The manager deliberately lets an internal failure throw instead of
    // folding it into "container dead" — swallowing it here would turn a DB
    // blip into a report that the pool is fine, which is how this class of bug
    // stayed invisible in the first place. The daemon's runBoundedPhase is what
    // isolates the cycle, not this function.
    const { deps } = fakeDeps(async () => {
      throw new Error("pool lookup failed");
    });
    __setDepsForTests(deps);

    await expect(processPoolHealthCheckCycle()).rejects.toThrow(
      "pool lookup failed",
    );
  });
});

describe("infra cycle ordering", () => {
  test("the health check runs before replenish in the daemon source", () => {
    // Order is load-bearing: replenish sizes the refill from current pool
    // depth, so it has to see the depth left AFTER dead entries are collected,
    // or it refills against a count inflated by entries that no longer exist.
    const source = Bun.file(
      new URL("./provisioning-worker.ts", import.meta.url).pathname,
    );
    return source.text().then((text) => {
      const drain = text.indexOf('"warm pool drain cycle"');
      const health = text.indexOf('"warm pool health check cycle"');
      const replenish = text.indexOf('"warm pool replenish cycle"');

      expect(drain).toBeGreaterThan(-1);
      expect(health).toBeGreaterThan(-1);
      expect(replenish).toBeGreaterThan(-1);
      expect(health).toBeGreaterThan(drain);
      expect(replenish).toBeGreaterThan(health);
    });
  });
});
