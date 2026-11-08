/** Routing publication and retirement against an explicitly configured scratch Redis. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  removeOwnedRedisKeys,
  requireRedisWriteReceipts,
} from "@elizaos/cloud-services-common/redis-ownership";
import Redis from "ioredis";
import { AgentRoutingPublisher } from "./agent-routing";

const redisUrl = process.env.AGENT_ROUTING_REDIS_TEST_URL;
const integration = redisUrl ? describe : describe.skip;

integration("agent routing publication against Redis", () => {
  let redis: Redis;
  const prefix = `agent-routing-${randomUUID()}`;
  const keys = new Set<string>();
  const key = (suffix: string) => {
    const value = `${prefix}:${suffix}`;
    keys.add(value);
    return value;
  };
  beforeAll(async () => {
    if (!redisUrl) throw new Error("AGENT_ROUTING_REDIS_TEST_URL is required");
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    if (redis) {
      if (keys.size) await redis.del(...keys);
      await redis.quit();
    }
  });

  test("an old heartbeat finishes before deletion and later snapshots cannot restore its route", async () => {
    const route = key("route");
    const entries = new Map([[route, "server"]]);
    const publisher = new AgentRoutingPublisher();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const writeSnapshot = async () => {
      const snapshot = [...entries];
      for (const [name, owner] of snapshot) await redis.set(name, owner);
    };
    const oldHeartbeat = publisher.publish(async () => {
      const snapshot = [...entries];
      started.resolve();
      await gate.promise;
      for (const [name, owner] of snapshot) await redis.set(name, owner);
    });
    await started.promise;
    const deleting = publisher.retire(
      () => removeOwnedRedisKeys(redis, "server", [route]),
      () => {
        entries.delete(route);
      },
    );
    const laterHeartbeat = publisher.publish(writeSnapshot);
    gate.resolve();
    await Promise.all([oldHeartbeat, deleting, laterHeartbeat]);
    expect(entries.has(route)).toBe(false);
    expect(await redis.get(route)).toBeNull();
  });

  test("failed cleanup retains the local entry and a retry can finish retirement", async () => {
    const route = key("retry");
    await redis.set(route, "server");
    let retained = true;
    const publisher = new AgentRoutingPublisher();
    await expect(
      publisher.retire(
        async () => {
          throw new Error("unacknowledged");
        },
        () => {
          retained = false;
        },
      ),
    ).rejects.toThrow("unacknowledged");
    expect(retained).toBe(true);
    expect(await redis.get(route)).toBe("server");
    await publisher.retire(
      () => removeOwnedRedisKeys(redis, "server", [route]),
      () => {
        retained = false;
      },
    );
    expect(retained).toBe(false);
    expect(await redis.get(route)).toBeNull();
  });

  test("shutdown fences queued snapshots and removes the final in-flight write", async () => {
    const status = key("shutdown");
    const publisher = new AgentRoutingPublisher();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const active = publisher.publish(async () => {
      started.resolve();
      await gate.promise;
      await redis.set(status, "running");
    });
    await started.promise;
    const queued = publisher.publish(async () => {
      await redis.set(status, "running");
    });
    const queuedOutcome = queued.then(
      () => undefined,
      (error: unknown) => error,
    );
    const closed = publisher.close(async () => {
      await redis.del(status);
    });
    gate.resolve();
    const [, rejection] = await Promise.all([active, queuedOutcome, closed]);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("publisher is closed");
    await expect(
      publisher.publish(async () => {
        await redis.set(status, "running");
      }),
    ).rejects.toThrow("publisher is closed");
    expect(await redis.get(status)).toBeNull();
  });

  test("publication requires an acknowledgement for every real Redis command", async () => {
    const status = key("receipt");
    await redis.set(status, "not-an-integer");
    const receipts = await redis.multi().incr(status).exec();
    expect(() =>
      requireRedisWriteReceipts(receipts, 1, "agent-server state"),
    ).toThrow("Redis agent-server state command failed");
    expect(() =>
      requireRedisWriteReceipts(null, 1, "agent-server state"),
    ).toThrow("not acknowledged");
  });
});
