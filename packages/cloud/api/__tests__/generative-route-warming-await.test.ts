/**
 * Covers the voice-only bounded hydration await on the generative auth gate:
 * warming converts to authorized inside the budget, budget expiry stays a
 * retryable 503, and the default unset option keeps chat's fast-fail path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: mock(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(),
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit: async () => null,
}));

mock.module("@/lib/services/inference-admission-snapshot", () => ({
  inferenceRateLimitConfig: () => ({}),
}));

const { requireGenerativeRouteCaller } = await import(
  "../src/lib/generative-route-auth"
);
const { ApiError } = await import("@/lib/api/cloud-worker-errors");

function workerContext() {
  const waited: Promise<unknown>[] = [];
  const store = new Map<string, unknown>();
  return {
    waited,
    c: {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waited.push(promise);
        },
      },
      req: { raw: new Request("https://api.eliza.app/api/v1/voice/tts") },
      get(key: string) {
        return store.get(key);
      },
      set(key: string, value: unknown) {
        store.set(key, value);
      },
    },
  };
}

const authorized = {
  kind: "authorized" as const,
  source: "cache" as const,
  ctx: {
    userId: "user-1",
    orgId: "org-1",
    apiKeyId: null,
    admission: { rateLimit: { strict: { limit: 10, windowMs: 1000 } } },
  },
};

describe("requireGenerativeRouteCaller awaitWarmingMs", () => {
  beforeEach(() => {
    resolveInferenceAuthContext.mockReset();
  });

  afterEach(() => {
    resolveInferenceAuthContext.mockReset();
  });

  test("converts warming to authorized when hydration settles inside the budget", async () => {
    const { c } = workerContext();
    const hydration = Promise.resolve({ kind: "authorized" });
    resolveInferenceAuthContext
      .mockResolvedValueOnce({ kind: "warming", hydration })
      .mockResolvedValueOnce(authorized);

    const caller = await requireGenerativeRouteCaller(c as never, {
      awaitWarmingMs: 1500,
    });

    expect(caller).toMatchObject({
      authSource: "combined_cache",
      user: { id: "user-1", organization_id: "org-1" },
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
  });

  test("returns the retryable warming 503 when the budget expires", async () => {
    const { c } = workerContext();
    let release: (() => void) | undefined;
    const hydration = new Promise((resolve) => {
      release = () => resolve({ kind: "authorized" });
    });
    resolveInferenceAuthContext
      .mockResolvedValueOnce({ kind: "warming", hydration })
      .mockResolvedValueOnce({ kind: "warming", hydration });

    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 20 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
    release?.();
  });

  test("cache-outage warming without a hydration promise fails fast", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({ kind: "warming" });

    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 1500 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("definitive rejection after hydration is surfaced, not swallowed", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext
      .mockResolvedValueOnce({
        kind: "warming",
        hydration: Promise.resolve({ kind: "rejected", status: 401 }),
      })
      .mockResolvedValueOnce({ kind: "rejected", status: 401 });

    await expect(
      requireGenerativeRouteCaller(c as never, { awaitWarmingMs: 1500 }),
    ).rejects.toMatchObject({
      status: 401,
      code: "authentication_required",
    });
  });

  test("default unset budget keeps the original warming 503", async () => {
    const { c } = workerContext();
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      hydration: Promise.resolve({ kind: "authorized" }),
    });

    await expect(
      requireGenerativeRouteCaller(c as never),
    ).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
    });
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });
});
