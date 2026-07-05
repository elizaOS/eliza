/**
 * Error-policy pins for the waifu webhook emitter (#13415).
 *
 * Proves the emit boundary keeps three internal-failure shapes DISTINGUISHABLE
 * from success and from the designed not-configured skip: a transport failure
 * surfaces as {delivered:false, status:null, error}, an SSRF-guard rejection
 * surfaces the same way without ever calling fetch, and a non-2xx response
 * surfaces as {delivered:false, status:<number>} — none of which may ever read
 * as a delivered success. Drives the real exported `emitWaifuWebhook` through
 * its documented `target`/`fetchImpl`/`now` seams; a public IP-literal target
 * exercises the real SSRF guard without a DNS round-trip, and global fetch is
 * mocked to throw as a hard net-access tripwire (restored in afterEach).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type EmitWaifuWebhookParams,
  emitWaifuWebhook,
  type WaifuWebhookTarget,
} from "./waifu-webhook";

// Public IPv4 literal (documentation range is forbidden; this one is routable
// and not reserved) so assertSafeOutboundUrl validates it without resolving DNS.
const PUBLIC_TARGET: WaifuWebhookTarget = {
  baseUrl: "https://93.184.216.34",
  secret: "test-webhook-secret",
};

const FIXED_NOW = () => new Date("2026-07-04T00:00:00.000Z");

const CONFIG_ENV_KEYS = [
  "ELIZA_CLOUD_WEBHOOK_URL",
  "WAIFU_WEBHOOK_URL",
  "WAIFU_API_BASE_URL",
  "WAIFU_CORE_URL",
  "ELIZA_CLOUD_WEBHOOK_SECRET",
  "WAIFU_WEBHOOK_SECRET",
  "WEBHOOK_RECEIVER_SECRET",
] as const;

let savedEnv: Record<string, string | undefined>;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = {};
  for (const key of CONFIG_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedFetch = globalThis.fetch;
  // Hard tripwire: any code path that reaches real global fetch fails loudly
  // instead of hitting the network. The emitter's default is safeFetch, and
  // every configured test injects fetchImpl, so this must never fire.
  globalThis.fetch = (() => {
    throw new Error("global fetch must not be called in this test");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of CONFIG_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function baseParams(overrides: Partial<EmitWaifuWebhookParams>): EmitWaifuWebhookParams {
  return {
    kind: "inference",
    payload: { event: "inference.spent", organizationId: "org_1" },
    idempotencyKey: "evt_1",
    now: FIXED_NOW,
    ...overrides,
  };
}

describe("emitWaifuWebhook error-policy boundary", () => {
  test("transport failure PROPAGATES as a distinguishable failure, never a fake success", async () => {
    const result = await emitWaifuWebhook(
      baseParams({
        target: PUBLIC_TARGET,
        fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED boom"))) as typeof fetch,
      }),
    );

    expect(result.delivered).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain("ECONNREFUSED");
    // The failure is NOT laundered into the designed not-configured skip.
    expect(result.skipped).toBeUndefined();
  });

  test("designed not-configured skip stays distinct from an internal failure", async () => {
    // No target arg and no env config → resolveWaifuWebhookTarget() returns null.
    const result = await emitWaifuWebhook(
      baseParams({ payload: { event: "inference.spent" }, idempotencyKey: "evt_skip" }),
    );

    expect(result.skipped).toBe("not_configured");
    expect(result.delivered).toBe(false);
    expect(result.status).toBeNull();
    // Critically: a designed skip carries NO error — it is not a failed call.
    expect(result.error).toBeUndefined();
  });

  test("successful delivery is a distinct shape (delivered:true + numeric status)", async () => {
    let called = 0;
    const result = await emitWaifuWebhook(
      baseParams({
        target: PUBLIC_TARGET,
        fetchImpl: (() => {
          called += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        }) as typeof fetch,
      }),
    );

    expect(called).toBe(1);
    expect(result.delivered).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
  });

  test("server-rejected (non-2xx) is distinct from unreachable: status:number, not error", async () => {
    const result = await emitWaifuWebhook(
      baseParams({
        target: PUBLIC_TARGET,
        fetchImpl: (() => Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
      }),
    );

    // "The server said no" keeps the real status code and is distinguishable
    // from "could not reach the server" (status:null + error) above.
    expect(result.delivered).toBe(false);
    expect(result.status).toBe(500);
    expect(result.error).toBeUndefined();
  });

  test("SSRF-guard rejection fails closed: delivered:false + error, and fetch is never called", async () => {
    let called = 0;
    const result = await emitWaifuWebhook(
      baseParams({
        // Cloud metadata IP — assertSafeOutboundUrl must reject this before any
        // socket is opened.
        target: { baseUrl: "http://169.254.169.254", secret: "s" },
        fetchImpl: (() => {
          called += 1;
          return Promise.resolve(new Response(null, { status: 200 }));
        }) as typeof fetch,
      }),
    );

    expect(called).toBe(0);
    expect(result.delivered).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBeTruthy();
  });
});
