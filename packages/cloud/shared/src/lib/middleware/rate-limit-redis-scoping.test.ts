/**
 * Pins the client scoping in the Redis rate limiter and the A2A task store:
 * state must live in the BACKEND, not in a cached client object, so that
 * per-call clients (the only safe shape on Cloudflare Workers, where a TCP
 * socket belongs to the request that opened it) still see one shared window.
 * MOCK_REDIS's backing map is process-global by design, which is what lets
 * these tests assert cross-instance visibility.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskStoreEntry } from "../services/a2a-task-store";

const savedEnv: Record<string, string | undefined> = {};
const REDIS_ENV_KEYS = [
  "MOCK_REDIS",
  "REDIS_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
] as const;
let savedWebSocketPair: PropertyDescriptor | undefined;

beforeEach(() => {
  for (const key of REDIS_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MOCK_REDIS = "1";
  savedWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    value: class WebSocketPair {},
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", savedWebSocketPair);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocketPair");
  }
  savedWebSocketPair = undefined;
});

describe("checkRateLimitRedis client scoping", () => {
  test("successive checks accumulate in one sliding window across client instances", async () => {
    const { checkRateLimitRedis } = await import("./rate-limit-redis");
    const key = `scoping-test-${Math.random().toString(36).slice(2)}`;

    const first = await checkRateLimitRedis(key, 60_000, 2);
    const second = await checkRateLimitRedis(key, 60_000, 2);
    const third = await checkRateLimitRedis(key, 60_000, 2);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    // Only works if the two prior requests landed in the SAME backend window
    // — i.e. the state outlives any single client instance.
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  test("does not reuse a stale Worker client when Redis config disappears", async () => {
    const { checkRateLimitRedis } = await import("./rate-limit-redis");
    const key = `stale-client-test-${Math.random().toString(36).slice(2)}`;

    expect((await checkRateLimitRedis(key, 60_000, 1)).allowed).toBe(true);
    delete process.env.MOCK_REDIS;

    const second = await checkRateLimitRedis(key, 60_000, 1);

    // A module-cached client would still see the first hit and block this.
    // Workers must build a fresh client in the current request context instead.
    expect(second.allowed).toBe(true);
    expect(second.retryAfter).toBeUndefined();
  });
});

describe("a2aTaskStore client scoping", () => {
  test("set/get/delete round-trips across per-call client instances", async () => {
    const { a2aTaskStoreService: a2aTaskStore } = await import("../services/a2a-task-store");
    const taskId = `task-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const entry: TaskStoreEntry = {
      task: {
        id: taskId,
        contextId: "ctx-1",
        status: { state: "submitted", timestamp: now },
      },
      userId: "user-scoping",
      organizationId: "org-scoping",
      createdAt: now,
      updatedAt: now,
    };

    await a2aTaskStore.set(taskId, entry);
    const fetched = await a2aTaskStore.get(taskId, "org-scoping");
    expect(fetched?.task.id).toBe(taskId);

    expect(await a2aTaskStore.delete(taskId, "org-scoping")).toBe(true);
    expect(await a2aTaskStore.get(taskId, "org-scoping")).toBeNull();
  });

  test("does not reuse a stale Worker client when Redis config disappears", async () => {
    const { a2aTaskStoreService: a2aTaskStore } = await import("../services/a2a-task-store");
    const taskId = `stale-task-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const entry: TaskStoreEntry = {
      task: {
        id: taskId,
        contextId: "ctx-1",
        status: { state: "submitted", timestamp: now },
      },
      userId: "user-scoping",
      organizationId: "org-scoping",
      createdAt: now,
      updatedAt: now,
    };

    await a2aTaskStore.set(taskId, entry);
    delete process.env.MOCK_REDIS;

    await expect(a2aTaskStore.get(taskId, "org-scoping")).rejects.toThrow(
      "Redis-backed shared storage is required",
    );
  });
});
