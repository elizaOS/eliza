/** Real Redis coverage; run with OPERATOR_REDIS_TEST_URL pointing at a scratch server. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { DeploymentStatusTracker } from "../deployment-status";
import {
  removeOwnedAgentRoutes,
  requireRoutingWriteReceipts,
} from "../routing-state";

const redisUrl = process.env.OPERATOR_REDIS_TEST_URL;
const integration = redisUrl ? describe : describe.skip;

integration("operator routing against Redis", () => {
  let redis: Redis;
  const prefix = `quint-operator-${randomUUID()}`;
  const keys = new Set<string>();
  const key = (suffix: string) => {
    const value = `${prefix}:${suffix}`;
    keys.add(value);
    return value;
  };

  beforeAll(async () => {
    if (!redisUrl) throw new Error("OPERATOR_REDIS_TEST_URL is required");
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    if (redis) {
      if (keys.size) await redis.del(...keys);
      await redis.quit();
    }
  });

  test("old-owner cleanup preserves a reassigned route and removes its own route", async () => {
    const agentId = `${prefix}-agent`;
    const routeKey = `agent:${agentId}:server`;
    keys.add(routeKey);
    await redis.set(routeKey, "new-server");
    await removeOwnedAgentRoutes(redis, "old-server", [agentId]);
    expect(await redis.get(routeKey)).toBe("new-server");
    await removeOwnedAgentRoutes(redis, "new-server", [agentId]);
    expect(await redis.get(routeKey)).toBeNull();
  });

  test("a real Redis command failure cannot acknowledge a routing transaction", async () => {
    const statusKey = key("transaction-status");
    const urlKey = key("transaction-url");
    await redis.set(urlKey, "http://server");
    const receipts = await redis
      .multi()
      .set(statusKey, "running")
      .incr(urlKey)
      .exec();
    expect(() => requireRoutingWriteReceipts(receipts, 2)).toThrow(
      "Redis routing command failed",
    );
    const corrected = await redis
      .multi()
      .set(statusKey, "running")
      .set(urlKey, "http://server")
      .exec();
    expect(() => requireRoutingWriteReceipts(corrected, 2)).not.toThrow();
    expect(() => requireRoutingWriteReceipts(null, 2)).toThrow(
      "not acknowledged",
    );
  });

  test("the same ready count restores Running after a reconcile reset", async () => {
    const routeKey = key("reset-route");
    const statusKey = key("reset-status");
    const tracker = new DeploymentStatusTracker(
      async (_name, phase) => {
        await redis.set(routeKey, phase);
      },
      async (_name, _namespace, status) => {
        await redis.set(statusKey, status?.phase ?? "unknown");
      },
    );
    await tracker.update(prefix, "test", 1, 1);
    await tracker.coordinate(prefix, "test", async () => {
      tracker.forget(prefix, "test");
      await redis.set(routeKey, "pending");
      await redis.set(statusKey, "Pending");
    });
    await tracker.update(prefix, "test", 1, 1);
    expect(await redis.get(routeKey)).toBe("running");
    expect(await redis.get(statusKey)).toBe("Running");
  });

  test("concurrent observations cannot publish an older phase after a newer phase", async () => {
    const routeKey = key("ordered-route");
    const statusKey = key("ordered-status");
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const tracker = new DeploymentStatusTracker(
      async (_name, phase) => {
        if (phase === "running") {
          started.resolve();
          await gate.promise;
        }
        await redis.set(routeKey, phase);
      },
      async (_name, _namespace, status) => {
        await redis.set(statusKey, status?.phase ?? "unknown");
      },
    );
    const older = tracker.update(prefix, "test", 1, 1);
    await started.promise;
    const newer = tracker.update(prefix, "test", 0, 0);
    gate.resolve();
    await Promise.all([older, newer]);
    expect(await redis.get(routeKey)).toBe("scaleddown");
    expect(await redis.get(statusKey)).toBe("ScaledDown");
  });

  test("finalization waits for in-flight writes and fences queued and late observations", async () => {
    const routeKey = key("final-route");
    const statusKey = key("final-status");
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const tracker = new DeploymentStatusTracker(
      async (_name, phase) => {
        started.resolve();
        await gate.promise;
        await redis.set(routeKey, phase);
      },
      async (_name, _namespace, status) => {
        await redis.set(statusKey, status?.phase ?? "unknown");
      },
    );
    const running = tracker.update(prefix, "test", 1, 1);
    await started.promise;
    const queued = tracker.update(prefix, "test", 0, 0);
    const finalize = tracker.finalize(prefix, "test", async () => {
      await redis.del(routeKey, statusKey);
    });
    gate.resolve();
    await Promise.all([running, queued, finalize]);
    await tracker.update(prefix, "test", 1, 1);
    expect(await redis.get(routeKey)).toBeNull();
    expect(await redis.get(statusKey)).toBeNull();
    await tracker.coordinate(prefix, "test", async () => {
      tracker.activate(prefix, "test");
    });
    await tracker.update(prefix, "test", 1, 1);
    expect(await redis.get(routeKey)).toBe("running");
  });

  test("an earlier queued activation cannot reopen a finalized Server", async () => {
    const routeKey = key("queued-activation-route");
    const statusKey = key("queued-activation-status");
    const gate = Promise.withResolvers<void>();
    const tracker = new DeploymentStatusTracker(
      async (_name, phase) => {
        await redis.set(routeKey, phase);
      },
      async (_name, _namespace, status) => {
        await redis.set(statusKey, status?.phase ?? "unknown");
      },
    );
    const inFlight = tracker.coordinate(prefix, "test", () => gate.promise);
    const priorReconcile = tracker.coordinate(prefix, "test", async () => {
      tracker.activate(prefix, "test");
    });
    const finalize = tracker.finalize(prefix, "test", async () => {
      await redis.del(routeKey, statusKey);
    });
    const lateObservation = tracker.update(prefix, "test", 1, 1);
    gate.resolve();
    await Promise.all([inFlight, priorReconcile, finalize, lateObservation]);
    expect(await redis.get(routeKey)).toBeNull();
    expect(await redis.get(statusKey)).toBeNull();
  });
});
