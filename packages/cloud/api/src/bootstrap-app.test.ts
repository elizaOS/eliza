/**
 * Application-shell contracts for middleware that must wrap every generated
 * route. These tests use the real generated router so they leave no
 * process-global Bun module mock behind for sibling files.
 */

import { expect, test } from "bun:test";

const { createApp, isRedisIndependentInferencePath } = await import(
  "./bootstrap-app"
);

function environment(limiter: {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}) {
  return {
    ENVIRONMENT: "staging",
    NODE_ENV: "production",
    REDIS_RATE_LIMITING: "false",
    GLOBAL_RATE_LIMITER: limiter,
  } as never;
}

test("the global native limiter rejects before auth and generated routes", async () => {
  const keys: string[] = [];
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/private/generated-route", {
      headers: { "cf-connecting-ip": "203.0.113.8" },
    }),
    environment({
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    }),
  );

  expect(keys).toEqual(["global:ip:203.0.113.8"]);
  expect(response.status).toBe(429);
  expect(response.headers.get("X-RateLimit-Policy")).toBe("cloudflare-native");
  expect(await response.json()).toMatchObject({
    code: "rate_limit_exceeded",
    retryAfter: 60,
  });
});

test("an allowed native decision preserves public locale routing", async () => {
  const keys: string[] = [];
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/api/i18n/locale", {
      headers: {
        "accept-language": "fr;q=0.8, ja;q=0.9",
        "cf-connecting-ip": "203.0.113.9",
      },
    }),
    environment({
      async limit({ key }) {
        keys.push(key);
        return { success: true };
      },
    }),
  );

  expect(keys).toEqual(["global:ip:203.0.113.9"]);
  expect(response.status).toBe(200);
  expect(response.headers.get("X-RateLimit-Policy")).toBe("cloudflare-native");
  const body = (await response.json()) as { language: string | null };
  expect(body).toEqual({ language: "ja" });
});

test("only model-dispatch surfaces bypass the legacy Railway Redis guard", () => {
  for (const path of [
    "/api/v1/chat",
    "/api/v1/chat/completions",
    "/api/v1/messages",
    "/api/v1/embeddings",
    "/api/v1/responses",
    "/api/v1/eliza/agents/agent-a/bridge",
    "/api/v1/eliza/agents/agent-a/stream",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a/messages",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a/messages/stream",
  ]) {
    expect(isRedisIndependentInferencePath(path)).toBe(true);
  }
  for (const path of [
    "/api/v1/chatty",
    "/api/v1/eliza/agents/agent-a/provision",
    "/api/v1/eliza/agents/agent-a/api/conversations/room-a",
    "/api/i18n/locale",
  ]) {
    expect(isRedisIndependentInferencePath(path)).toBe(false);
  }
});

test("production inference remains reachable when Railway Redis is unavailable", async () => {
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/api/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.10",
      },
      body: JSON.stringify({ model: "embedding-model", input: "hi" }),
    }),
    {
      ENVIRONMENT: "production",
      NODE_ENV: "production",
      REDIS_RATE_LIMITING: "true",
      GLOBAL_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
      CHAT_ROUTE_RATE_LIMITER: {
        async limit() {
          return { success: true };
        },
      },
    } as never,
  );

  expect(response.status).toBe(401);
  expect(await response.json()).not.toMatchObject({
    code: "RATE_LIMIT_UNAVAILABLE",
  });
});
