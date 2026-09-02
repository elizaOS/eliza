/** Exercises the inference shell's native-first, bounded-fallback ingress guard. */

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv, RuntimeRateLimitBinding } from "@/types/cloud-worker-env";
import {
  _resetInferenceIngressRateLimit,
  inferenceIngressRateLimit,
} from "./inference-ingress-rate-limit";

function request(method = "POST", ip = "203.0.113.8"): Request {
  return new Request("https://api.elizacloud.ai/inference", {
    method,
    headers: { "cf-connecting-ip": ip },
  });
}

function createApp(): { app: Hono<AppEnv>; routeCalls: () => number } {
  let calls = 0;
  const app = new Hono<AppEnv>();
  app.use("*", inferenceIngressRateLimit());
  app.all("*", (c) => {
    calls += 1;
    return c.json({ ok: true });
  });
  return { app, routeCalls: () => calls };
}

function envWith(binding?: RuntimeRateLimitBinding): AppEnv["Bindings"] {
  return {
    DATABASE_URL: "postgres://test.invalid/eliza",
    BLOB: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
    },
    GLOBAL_RATE_LIMITER: binding,
  };
}

describe("inference ingress rate limit", () => {
  afterEach(() => _resetInferenceIngressRateLimit());

  test("uses the healthy Cloudflare counter as the primary verdict", async () => {
    const keys: string[] = [];
    const { app, routeCalls } = createApp();
    const response = await app.fetch(
      request(),
      envWith({
        async limit({ key }) {
          keys.push(key);
          return { success: true };
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(keys).toEqual(["inference:203.0.113.8"]);
    expect(routeCalls()).toBe(1);
  });

  test("enforces a native denial before route authentication", async () => {
    const { app, routeCalls } = createApp();
    const response = await app.fetch(
      request(),
      envWith({
        async limit() {
          return { success: false };
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Policy")).toBe(
      "cloudflare-native",
    );
    expect(routeCalls()).toBe(0);
  });

  test("falls back locally when the native binding throws", async () => {
    const { app, routeCalls } = createApp();
    const response = await app.fetch(
      request(),
      envWith({
        async limit() {
          throw new Error("binding unavailable");
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(routeCalls()).toBe(1);
  });

  test("bounds a stalled binding and observes its late rejection", async () => {
    let rejectBinding: ((error: Error) => void) | undefined;
    const { app, routeCalls } = createApp();
    const response = await app.fetch(
      request(),
      envWith({
        limit() {
          return new Promise((_, reject) => {
            rejectBinding = reject;
          });
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(routeCalls()).toBe(1);
    rejectBinding?.(new Error("late binding rejection"));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("bounds fallback floods without Redis or Durable Object access", async () => {
    const { app, routeCalls } = createApp();
    const env = envWith();
    Object.defineProperty(env, "INFERENCE_ADMISSION_GATES", {
      get() {
        throw new Error("Durable Object binding must not be read");
      },
    });

    for (let requestNumber = 0; requestNumber < 600; requestNumber += 1) {
      expect((await app.fetch(request(), env)).status).toBe(200);
    }
    const denied = await app.fetch(request(), env);

    expect(denied.status).toBe(429);
    expect(denied.headers.get("X-RateLimit-Policy")).toBe(
      "worker-isolate-fallback",
    );
    expect(denied.headers.get("Retry-After")).not.toBeNull();
    expect(routeCalls()).toBe(600);
  });

  test("does not charge CORS preflight to either limiter", async () => {
    let limiterCalls = 0;
    const { app } = createApp();
    const response = await app.fetch(
      request("OPTIONS"),
      envWith({
        async limit() {
          limiterCalls += 1;
          return { success: false };
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(limiterCalls).toBe(0);
  });
});
