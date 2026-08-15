/**
 * Exercises durable Discord install-welcome delivery, retry recovery, and
 * week-long idempotency without a live Redis or Discord account.
 */
import { describe, expect, test } from "bun:test";
import {
  type DiscordInstallWelcomeJob,
  DiscordInstallWelcomeQueue,
  type DiscordInstallWelcomeRedis,
  sendDiscordInstallWelcome,
} from "../src/discord-install-welcome-queue";

class TestRedis implements DiscordInstallWelcomeRedis {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, string>();
  readonly setTtls: number[] = [];
  failNextLpush = false;

  async get<T = string>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set(
    key: string,
    value: unknown,
    options?: { ex?: number },
  ): Promise<string> {
    this.values.set(key, String(value));
    if (options?.ex) this.setTtls.push(options.ex);
    return "OK";
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    if (this.failNextLpush) {
      this.failNextLpush = false;
      throw new Error("Redis lpush unavailable");
    }
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lmove(
    source: string,
    destination: string,
    _whereFrom: "left" | "right",
    _whereTo: "left" | "right",
  ): Promise<string | null> {
    const sourceList = this.lists.get(source) ?? [];
    const value = sourceList.pop() ?? null;
    if (!value) return null;
    const destinationList = this.lists.get(destination) ?? [];
    destinationList.unshift(value);
    this.lists.set(source, sourceList);
    this.lists.set(destination, destinationList);
    return value;
  }

  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    let remaining = Math.abs(count);
    let removed = 0;
    this.lists.set(
      key,
      list.filter((entry) => {
        if (entry !== value || remaining === 0) return true;
        remaining -= 1;
        removed += 1;
        return false;
      }),
    );
    return removed;
  }
}

const job: DiscordInstallWelcomeJob = {
  id: "a".repeat(64),
  eventTimestamp: "2026-08-14T09:00:00.000000",
  user: { id: "498273781589213185", globalName: "shaw" },
};

describe("DiscordInstallWelcomeQueue", () => {
  test("uses deterministic nonce and disables all allowed mention parsing", async () => {
    const bodies: Record<string, unknown>[] = [];
    await sendDiscordInstallWelcome(job, {
      botToken: "token",
      fetchImpl: async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(
          String(input).endsWith("/users/@me/channels")
            ? { id: "dm-channel" }
            : { id: "message" },
        );
      },
    });

    expect(bodies[1]).toMatchObject({
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
    expect(String(bodies[1]?.nonce)).toMatch(/^\d+$/);
  });

  test("requeues partial REST failure and deduplicates the recovered delivery", async () => {
    const redis = new TestRedis();
    let requestCount = 0;
    let failFirstMessage = true;
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "token",
      async (input) => {
        requestCount += 1;
        if (String(input).endsWith("/users/@me/channels")) {
          return Response.json({ id: "dm-channel" });
        }
        if (failFirstMessage) {
          failFirstMessage = false;
          return Response.json({ message: "temporary" }, { status: 503 });
        }
        return Response.json({ id: "message" });
      },
    );

    await queue.enqueue(job);
    expect(await queue.drainOnce()).toBe(true);
    expect(await queue.drainOnce()).toBe(true);
    expect(requestCount).toBe(4);
    expect(redis.setTtls).toEqual([7 * 24 * 60 * 60]);

    await queue.enqueue(job);
    expect(await queue.drainOnce()).toBe(true);
    expect(requestCount).toBe(4);
  });

  test("recovers an abandoned processing claim on startup", async () => {
    const redis = new TestRedis();
    redis.lists.set("discord:eliza-app:install-welcome:processing", [
      JSON.stringify(job),
    ]);
    let delivered = false;
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "token",
      async (input) => {
        if (String(input).endsWith("/users/@me/channels")) {
          return Response.json({ id: "dm-channel" });
        }
        delivered = true;
        return Response.json({ id: "message" });
      },
    );

    await queue.start();
    await queue.stop();

    expect(delivered).toBe(true);
  });

  test("recovers in-process when requeue itself transiently fails", async () => {
    const redis = new TestRedis();
    let failDiscord = true;
    const queue = new DiscordInstallWelcomeQueue(
      redis,
      "token",
      async (input) => {
        if (String(input).endsWith("/users/@me/channels")) {
          return Response.json({ id: "dm-channel" });
        }
        if (failDiscord) {
          failDiscord = false;
          redis.failNextLpush = true;
          return Response.json({ message: "temporary" }, { status: 503 });
        }
        return Response.json({ id: "message" });
      },
    );

    await queue.enqueue(job);
    await expect(queue.drainOnce()).rejects.toThrow("Redis lpush unavailable");
    expect(await queue.drainOnce()).toBe(true);
    expect(redis.setTtls).toEqual([7 * 24 * 60 * 60]);
  });
});
