/**
 * Application-shell contracts for middleware that must wrap every generated
 * route. These tests use the real generated router so they leave no
 * process-global Bun module mock behind for sibling files.
 */

import { expect, test } from "bun:test";
import { mobileApiKeyIngressRateLimitKey } from "@/lib/auth/mobile-api-key";

const { createApp } = await import("./bootstrap-app");

function environment(
  limiter: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  },
  mobileLimiter?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  },
) {
  return {
    ENVIRONMENT: "staging",
    NODE_ENV: "production",
    REDIS_RATE_LIMITING: "false",
    GLOBAL_RATE_LIMITER: limiter,
    MOBILE_API_KEY_INGRESS_LIMITER: mobileLimiter,
  } as never;
}

test("syntactically valid mobile keys hit a non-secret credential limiter before auth", async () => {
  const globalKeys: string[] = [];
  const mobileKeys: string[] = [];
  const mobileSecret = `eliza_mobile_${"a".repeat(64)}`;
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/api/v1/models", {
      headers: {
        authorization: `Bearer ${mobileSecret}`,
        "cf-connecting-ip": "203.0.113.10",
      },
    }),
    environment(
      {
        async limit({ key }) {
          globalKeys.push(key);
          return { success: true };
        },
      },
      {
        async limit({ key }) {
          mobileKeys.push(key);
          return { success: false };
        },
      },
    ),
  );

  expect(globalKeys).toEqual(["global:ip:203.0.113.10"]);
  expect(mobileKeys).toEqual([mobileApiKeyIngressRateLimitKey(mobileSecret)]);
  expect(mobileKeys[0]).not.toContain(mobileSecret);
  expect(response.status).toBe(429);
});

test("different mobile credentials on one carrier NAT have independent buckets", async () => {
  const mobileKeys: string[] = [];
  const mobileA = `eliza_mobile_${"a".repeat(64)}`;
  const mobileB = `eliza_mobile_${"b".repeat(64)}`;
  const blockedKey = mobileApiKeyIngressRateLimitKey(mobileA);
  const app = createApp();
  const env = environment(
    {
      async limit() {
        return { success: true };
      },
    },
    {
      async limit({ key }) {
        mobileKeys.push(key);
        return { success: key !== blockedKey };
      },
    },
  );
  const request = (secret: string) =>
    app.fetch(
      new Request("https://api.example.test/api/v1/models", {
        headers: {
          authorization: `Bearer ${secret}`,
          "cf-connecting-ip": "203.0.113.10",
        },
      }),
      env,
    );

  const blocked = await request(mobileA);
  const isolated = await request(mobileB);

  expect(blocked.status).toBe(429);
  expect(isolated.status).not.toBe(429);
  expect(mobileKeys).toEqual([
    mobileApiKeyIngressRateLimitKey(mobileA),
    mobileApiKeyIngressRateLimitKey(mobileB),
  ]);
});

test("one mobile credential shares its bucket when the client's IP changes", async () => {
  const mobileKeys: string[] = [];
  const mobileSecret = `eliza_mobile_${"c".repeat(64)}`;
  const app = createApp();
  const env = environment(
    {
      async limit() {
        return { success: true };
      },
    },
    {
      async limit({ key }) {
        mobileKeys.push(key);
        return { success: true };
      },
    },
  );

  for (const ip of ["203.0.113.20", "198.51.100.40"]) {
    await app.fetch(
      new Request("https://api.example.test/api/v1/models", {
        headers: {
          "x-api-key": mobileSecret,
          "cf-connecting-ip": ip,
        },
      }),
      env,
    );
  }

  expect(mobileKeys).toEqual([
    mobileApiKeyIngressRateLimitKey(mobileSecret),
    mobileApiKeyIngressRateLimitKey(mobileSecret),
  ]);
});

test("the global IP backstop rejects mobile key spray before credential limiting", async () => {
  let mobileLimitCalls = 0;
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/api/v1/models", {
      headers: {
        authorization: `Bearer eliza_mobile_${"d".repeat(64)}`,
        "cf-connecting-ip": "203.0.113.30",
      },
    }),
    environment(
      {
        async limit() {
          return { success: false };
        },
      },
      {
        async limit() {
          mobileLimitCalls++;
          return { success: true };
        },
      },
    ),
  );

  expect(response.status).toBe(429);
  expect(mobileLimitCalls).toBe(0);
});

test("mobile ingress fails closed when its native limiter binding is absent", async () => {
  const app = createApp();
  const response = await app.fetch(
    new Request("https://api.example.test/api/v1/models", {
      headers: {
        authorization: `Bearer eliza_mobile_${"a".repeat(64)}`,
        "cf-connecting-ip": "203.0.113.12",
      },
    }),
    environment({
      async limit() {
        return { success: true };
      },
    }),
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "rate_limit_unavailable",
    success: false,
  });
});

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
