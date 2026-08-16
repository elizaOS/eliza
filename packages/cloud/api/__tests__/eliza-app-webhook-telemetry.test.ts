/**
 * Pins privacy-safe trace propagation and proxy timing at the provider-webhook BFF boundary.
 * The upstream transport is deterministic; assertions cover the real header and log contract.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const loggerInfo = mock();
const loggerError = mock();
const loggerWarn = mock();
mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: loggerError,
    info: loggerInfo,
    warn: loggerWarn,
    debug: mock(),
  },
}));

const { forwardToWebhookGateway } = (await import(
  "../eliza-app/webhook/_forward"
)) as typeof import("../eliza-app/webhook/_forward");

const TRACE_ID = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;
let forwardedHeaders: Headers | null;

beforeEach(() => {
  forwardedHeaders = null;
  loggerInfo.mockClear();
  loggerError.mockClear();
  loggerWarn.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function forward(): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("traceId", TRACE_ID);
    await next();
  });
  app.post("/api/eliza-app/webhook/telegram", (c) =>
    forwardToWebhookGateway(
      c as unknown as Parameters<typeof forwardToWebhookGateway>[0],
      "telegram",
    ),
  );
  return await app.fetch(
    new Request("https://api.example.test/api/eliza-app/webhook/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-eliza-trace-id": "22222222-2222-4222-8222-222222222222",
      },
      body: "{}",
    }),
    {
      ELIZA_APP_WEBHOOK_GATEWAY_URL: "https://gateway.internal.test",
    } as AppEnv["Bindings"],
  );
}

describe("eliza-app webhook proxy telemetry", () => {
  test("propagates the BFF trace and records successful upstream timing", async () => {
    globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
      forwardedHeaders = new Headers(init?.headers);
      return new Response("{}", {
        status: 200,
        headers: { "Server-Timing": "gateway;dur=12" },
      });
    }) as unknown as typeof fetch;

    const response = await forward();

    expect(forwardedHeaders?.get("X-Eliza-Trace-Id")).toBe(TRACE_ID);
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(TRACE_ID);
    expect(response.headers.get("Server-Timing")).toContain("gateway;dur=12");
    expect(response.headers.get("Server-Timing")).toMatch(
      /webhook_gateway_proxy;dur=\d+(?:\.\d+)?/,
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      "[ElizaAppWebhook] upstream request completed",
      expect.objectContaining({
        traceId: TRACE_ID,
        serviceName: "webhook gateway",
        status: 200,
        durationMs: expect.any(Number),
      }),
    );
  });

  test("preserves correlation and timing when the upstream transport fails", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("transport unavailable");
    }) as unknown as typeof fetch;

    const response = await forward();

    expect(response.status).toBe(502);
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(TRACE_ID);
    expect(response.headers.get("Server-Timing")).toMatch(
      /webhook_gateway_proxy;dur=\d+(?:\.\d+)?/,
    );
    expect(loggerError).toHaveBeenCalledWith(
      "[ElizaAppWebhook] Upstream request failed",
      expect.objectContaining({
        traceId: TRACE_ID,
        serviceName: "webhook gateway",
        durationMs: expect.any(Number),
        error: "transport unavailable",
      }),
    );
  });

  test("surfaces upstream 5xx responses through the always-on warning sink", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    ) as unknown as typeof fetch;

    const response = await forward();

    expect(response.status).toBe(503);
    expect(loggerWarn).toHaveBeenCalledWith(
      "[ElizaAppWebhook] upstream request slow or failed",
      expect.objectContaining({
        traceId: TRACE_ID,
        serviceName: "webhook gateway",
        status: 503,
        durationMs: expect.any(Number),
      }),
    );
  });
});
