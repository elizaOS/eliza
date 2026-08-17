/**
 * Bounded inline hydration for voice generative routes (#20557): when the
 * per-user inference auth cache entry has expired (60s TTL) the voice
 * STT/TTS routes must not surface an immediate retryable 503 — they opt
 * into one bounded await of the already-coalesced hydration and re-resolve.
 *
 * Deterministic harness: the combined inference auth resolver is replaced
 * with a scriptable sequence, so each test controls exactly which
 * resolutions the caller observes (warming, authorized, rejected, outage).
 * Rate limiting is disarmed so assertions target only the auth wait.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import type { AppContext } from "@/types/cloud-worker-env";

type ScriptedResolution =
  | { kind: "authorized"; ctx: Record<string, unknown> }
  | { kind: "warming"; hydration?: Promise<void> }
  | { kind: "rejected"; status: 401 | 403 }
  | { kind: "suspended" };

const resolveCalls: unknown[][] = [];
let scripted: ScriptedResolution[] = [];

const resolveInferenceAuthContext = mock(async (...args: unknown[]) => {
  resolveCalls.push(args);
  const next = scripted.shift();
  if (!next) throw new Error("no scripted resolution left");
  return next;
});
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));

const enforceOrgRateLimit = mock(
  async (_orgId: string, _endpoint: string, ..._rest: unknown[]) => null,
);
mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError: class extends Error {},
}));
mock.module("@/lib/services/inference-admission-snapshot", () => ({
  loadInferenceAdmissionSnapshot: async () => null,
  inferenceRateLimitConfig: () => ({}),
}));

const { requireGenerativeRouteCaller } = await import(
  "@/api-app/lib/generative-route-auth"
);

const ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000dd";

function context(): AppContext {
  const store = new Map<string, unknown>();
  const waitUntilTasks: Promise<unknown>[] = [];
  return {
    req: {
      raw: new Request("https://api.test/v1/voice/tts", { method: "POST" }),
    },
    executionCtx: {
      waitUntil(promise: Promise<unknown>) {
        waitUntilTasks.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => void store.set(key, value),
  } as unknown as AppContext;
}

beforeEach(() => {
  resolveCalls.length = 0;
  scripted = [];
  resolveInferenceAuthContext.mockClear();
  enforceOrgRateLimit.mockClear();
});

describe("requireGenerativeRouteCaller awaitWarmingMs (#20557)", () => {
  test("voice budget converts warming into authorized without a client retry", async () => {
    const gate = Promise.withResolvers<void>();
    scripted = [
      {
        kind: "warming",
        // Hydration settles quickly — inside the 1500ms voice budget.
        hydration: gate.promise,
      },
      {
        kind: "authorized",
        ctx: { userId: USER, orgId: ORG, apiKeyId: null },
      },
    ];

    const callerPromise = requireGenerativeRouteCaller(context(), {
      compatibility: "raw",
      rateLimitEndpoint: "strict",
      awaitWarmingMs: 1500,
    });

    // Let the microtask queue settle so the first resolve has returned
    // warming before the hydration resolves.
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();
    const caller = await callerPromise;

    expect(caller.authSource).toBe("combined_cache");
    expect(caller.user.id).toBe(USER);
    expect(caller.user.organization_id).toBe(ORG);
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
  });

  test("budget expiry preserves the immediate retryable 503 verbatim", async () => {
    const never = new Promise<void>(() => {});
    scripted = [
      { kind: "warming", hydration: never },
      { kind: "warming", hydration: never },
    ];

    const startedAt = Date.now();
    let apiError: (typeof ApiError)["prototype"] | undefined;
    try {
      await requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 20,
      });
      throw new Error("expected a warming ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      apiError = error as InstanceType<typeof ApiError>;
    }
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(18);
    expect(apiError?.status).toBe(503);
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
  });

  test("warming without a hydration promise (cache outage) fails fast, no budget burn", async () => {
    scripted = [{ kind: "warming" }];

    const startedAt = Date.now();
    await expect(
      requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 1500,
      }),
    ).rejects.toThrow("Authorization cache is warming; retry shortly");
    expect(Date.now() - startedAt).toBeLessThan(1500);
    // No re-resolve was attempted: the outage branch skips the retry.
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
  });

  test("unset budget keeps the legacy fast-fail behavior exactly", async () => {
    const never = new Promise<void>(() => {});
    scripted = [{ kind: "warming", hydration: never }];

    await expect(
      requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
      }),
    ).rejects.toThrow("Authorization cache is warming; retry shortly");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
  });

  test("a definitive rejection after the awaited hydration surfaces verbatim", async () => {
    scripted = [
      { kind: "warming", hydration: Promise.resolve() },
      { kind: "rejected", status: 401 },
    ];

    await expect(
      requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 1500,
      }),
    ).rejects.toThrow("Authentication required");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
  });

  test("a rejecting hydration degrades to the retryable warming 503, not an opaque error", async () => {
    // Silence at creation so the rejected promise never crosses an await
    // boundary handler-less (the race attaches its own catch later).
    const rejecting = Promise.reject(new Error("cache write failed"));
    rejecting.catch(() => undefined);
    scripted = [
      { kind: "warming", hydration: rejecting },
      { kind: "warming", hydration: new Promise<void>(() => {}) },
    ];

    await expect(
      requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 100,
      }),
    ).rejects.toThrow("Authorization cache is warming; retry shortly");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
  });

  test("warming converted to authorized enforces the org rate limit exactly once", async () => {
    scripted = [
      { kind: "warming", hydration: Promise.resolve() },
      {
        kind: "authorized",
        ctx: { userId: USER, orgId: ORG, apiKeyId: null },
      },
    ];

    const caller = await requireGenerativeRouteCaller(context(), {
      compatibility: "raw",
      rateLimitEndpoint: "strict",
      awaitWarmingMs: 1500,
    });

    expect(caller.user.organization_id).toBe(ORG);
    expect(enforceOrgRateLimit).toHaveBeenCalledTimes(1);
    expect(enforceOrgRateLimit.mock.calls[0][0]).toBe(ORG);
    expect(enforceOrgRateLimit.mock.calls[0][1]).toBe("strict");
  });

  test("hydration settled but the reread still warming keeps the retryable 503", async () => {
    scripted = [
      { kind: "warming", hydration: Promise.resolve() },
      { kind: "warming", hydration: new Promise<void>(() => {}) },
    ];

    await expect(
      requireGenerativeRouteCaller(context(), {
        compatibility: "raw",
        rateLimitEndpoint: "strict",
        awaitWarmingMs: 1500,
      }),
    ).rejects.toThrow("Authorization cache is warming; retry shortly");
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(2);
    expect(enforceOrgRateLimit).not.toHaveBeenCalled();
  });
});
