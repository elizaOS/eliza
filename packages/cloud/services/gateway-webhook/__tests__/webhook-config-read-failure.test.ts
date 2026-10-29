/**
 * A failure to READ an agent's webhook config is not the same answer as the
 * cloud saying the agent has none. The first is retryable; the second is final.
 * Conflating them made the gateway answer 404 "not configured" to Telegram /
 * Meta / Twilio whenever the config API was down, and those platforms never
 * redeliver a 4xx — the inbound message was dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformAdapter } from "../src/adapters/types";
import type { GatewayRedis } from "../src/redis";
import {
  resolveWebhookConfig,
  WebhookConfigUnavailableError,
} from "../src/webhook-config";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type RedisStub = GatewayRedis & { store: Map<string, string> };

function memoryRedis(
  overrides: Partial<Record<"get" | "set", unknown>> = {},
): RedisStub {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) =>
      store.has(key) ? JSON.parse(store.get(key) as string) : null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    ...overrides,
  } as unknown as RedisStub;
}

function resolve(redis: GatewayRedis) {
  return resolveWebhookConfig(
    redis,
    "https://cloud.example.test",
    { Authorization: "Bearer test" },
    "telegram",
    "project-1",
    "agent-1",
    async () => ({ Authorization: "Bearer refreshed" }),
  );
}

function jsonFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("webhook config read failures", () => {
  test("rejects when the config API answers 5xx instead of reporting no config", async () => {
    globalThis.fetch = jsonFetch(503, { error: "unavailable" });
    await expect(resolve(memoryRedis())).rejects.toBeInstanceOf(
      WebhookConfigUnavailableError,
    );
  });

  test("rejects when the config API is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(resolve(memoryRedis())).rejects.toBeInstanceOf(
      WebhookConfigUnavailableError,
    );
  });

  test("rejects when the config API body is not JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>gateway timeout</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch;
    await expect(resolve(memoryRedis())).rejects.toBeInstanceOf(
      WebhookConfigUnavailableError,
    );
  });

  test("still reports 'no config' when the cloud says the agent has none", async () => {
    globalThis.fetch = jsonFetch(404, { error: "not found" });
    const redis = memoryRedis();
    await expect(resolve(redis)).resolves.toBeNull();
    expect(redis.store.has("webhook-config:telegram:agent:agent-1")).toBe(true);
  });

  test("still serves a fetched config when the cache write fails", async () => {
    globalThis.fetch = jsonFetch(200, { botToken: "123:abc", botId: "123" });
    const redis = memoryRedis({
      set: async () => {
        throw new Error("redis down");
      },
    });
    await expect(resolve(redis)).resolves.toMatchObject({
      botToken: "123:abc",
    });
  });

  test("handleWebhook asks the platform to retry instead of dropping the update", async () => {
    globalThis.fetch = jsonFetch(500, { error: "internal" });
    const { handleWebhook } = await import("../src/webhook-handler");
    const response = await handleWebhook(
      new Request(
        "https://gateway.example.test/webhook/project-1/telegram/agent-1",
        {
          method: "POST",
          body: JSON.stringify({ update_id: 1 }),
        },
      ),
      { platform: "telegram" } as unknown as PlatformAdapter,
      {
        redis: memoryRedis(),
        cloudBaseUrl: "https://cloud.example.test",
        getAuthHeader: () => ({ Authorization: "Bearer test" }),
        reacquireAuthHeader: async () => ({
          Authorization: "Bearer refreshed",
        }),
      },
      "project-1",
      "agent-1",
    );
    // 404 tells Telegram "this endpoint is gone, do not retry".
    expect(response.status).toBe(503);
  });

  test("a held turn stays queued when the config read fails", async () => {
    globalThis.fetch = jsonFetch(503, { error: "unavailable" });
    const { redeliverHeldWebhook } = await import("../src/webhook-handler");
    const outcome = await redeliverHeldWebhook(
      {
        v: 1,
        dedupKey: "held-1",
        platform: "telegram",
        project: "project-1",
        agentId: "agent-1",
        traceId: "trace-1",
        event: { messageId: "msg-1" },
        heldAt: Date.now(),
        attempts: 0,
        code: "personal_cutover_in_progress",
      } as never,
      { platform: "telegram" } as unknown as PlatformAdapter,
      {
        redis: memoryRedis(),
        cloudBaseUrl: "https://cloud.example.test",
        getAuthHeader: () => ({ Authorization: "Bearer test" }),
        reacquireAuthHeader: async () => ({
          Authorization: "Bearer refreshed",
        }),
      } as never,
    );
    // Settling here would drop a message the provider already acknowledged.
    expect(outcome).toEqual({
      kind: "held",
      signal: {
        code: "personal_cutover_in_progress",
        retryAfterSeconds: null,
      },
    });
  });
});
