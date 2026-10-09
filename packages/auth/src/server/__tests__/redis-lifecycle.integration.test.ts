import { expect, test } from "bun:test";
import type { Redis } from "ioredis";
import {
  initRedis,
  isRedisAvailable,
  shutdownRedis,
} from "../api/middleware/redis.ts";
import { getRedis } from "../redis/client.ts";

test("shutdown releases a Redis client after a failed startup ping", async () => {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = reservation.port;
  await reservation.stop(true);
  const previous = {
    REDIS_URL: process.env.REDIS_URL,
    REDIS_DRIVER: process.env.REDIS_DRIVER,
  };
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.REDIS_DRIVER = "ioredis";
  const signalListeners = process.listenerCount("SIGTERM");
  try {
    const owned = getRedis() as unknown as Redis;
    expect(await initRedis()).toBe(false);
    expect(isRedisAvailable()).toBe(false);
    let reconnects = 0;
    owned.on("connecting", () => {
      reconnects += 1;
    });
    await shutdownRedis();
    // The next failed-startup reconnect would occur within 800 ms.
    await Bun.sleep(1_100);
    expect(reconnects).toBe(0);
    await shutdownRedis();
    expect(process.listenerCount("SIGTERM")).toBe(signalListeners);
  } finally {
    await shutdownRedis();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
