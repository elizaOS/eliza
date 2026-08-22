// Pins the fail-closed contract of the onboarding phone-link path: a genuine
// linkPhoneToUser infra failure must PROPAGATE out of runOnboardingChat, while
// its designed tenant-safety decline (success:false) stays a distinguishable
// non-throwing outcome that lets onboarding continue. Deterministic lib
// fixtures (no live model, no network).
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import * as provisioningObservation from "./provisioning-observation";

const sessionCache = new Map<string, unknown>();
const getElizaAppProvisioningStatus = mock();
const linkPhoneToUser = mock();
const launchManagedElizaAgent = mock();
let cloudEnv: Record<string, string | undefined> = {};
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };

mock.module("../../cache/client", () => ({
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
  },
}));

mock.module("../../runtime/cloud-bindings", () => ({
  ...REAL_CLOUD_BINDINGS,
  getCloudAwareEnv: mock(() => cloudEnv),
}));

mock.module("../../utils/phone-normalization", () => ({
  normalizePhoneNumber: (value: string) => value,
}));

mock.module("../eliza-managed-launch", () => ({
  launchManagedElizaAgent,
  // The mock must expose every name imported by onboarding-chat so this suite
  // exercises the error policy instead of failing during module linking.
  readManagedElizaAgentConnection: mock(),
}));

mock.module("./provisioning", () => ({
  ...provisioningObservation,
  getElizaAppProvisioningStatus,
}));

mock.module("./user-service", () => ({
  elizaAppUserService: {
    linkPhoneToUser,
  },
}));

const { runOnboardingChat, onboardingFetch } = await import(
  `./onboarding-chat.ts?test=onboarding-error-policy-${Date.now()}`
);

const PHONE = "+14155550123";
const PLATFORM_SESSION = `platform:blooio:${PHONE}`;

function provisioning() {
  return { status: "provisioning", agentId: "agent-1", bridgeUrl: null, sandbox: null };
}

function authedTrustedPhoneTurn() {
  return runOnboardingChat({
    message: "My name is Sam",
    platform: "blooio",
    platformUserId: PHONE,
    sessionId: PLATFORM_SESSION,
    trustedPlatformIdentity: true,
    authenticatedUser: { userId: "user-1", organizationId: "org-1" },
  });
}

describe("onboarding-chat phone-link error policy", () => {
  beforeEach(() => {
    sessionCache.clear();
    getElizaAppProvisioningStatus.mockReset();
    linkPhoneToUser.mockReset();
    launchManagedElizaAgent.mockReset();
    getElizaAppProvisioningStatus.mockResolvedValue(provisioning());
    cloudEnv = {};
  });

  afterEach(() => {
    cloudEnv = process.env;
  });

  afterAll(() => {
    mock.module("../../runtime/cloud-bindings", () => REAL_CLOUD_BINDINGS);
    mock.restore();
  });

  test("a genuine linkPhoneToUser infra failure PROPAGATES (fail closed, never swallowed)", async () => {
    linkPhoneToUser.mockRejectedValue(new Error("db connection reset"));

    await expect(authedTrustedPhoneTurn()).rejects.toThrow("db connection reset");

    // The link ran; the throw was not turned into a healthy-looking result.
    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
  });

  test("a designed tenant-safety decline (success:false) stays distinct: onboarding continues, no throw", async () => {
    linkPhoneToUser.mockResolvedValue({
      success: false,
      error: "This phone number is already linked to another account",
    });

    const result = await authedTrustedPhoneTurn();

    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    // A business decline is NOT an internal failure — the turn resolves with a
    // real reply and observes the existing lifecycle state without mutating it.
    expect(typeof result.reply).toBe("string");
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.requiresLogin).toBe(false);
    expect(getElizaAppProvisioningStatus).toHaveBeenCalledWith("org-1", "user-1");
    expect(result.provisioning.status).toBe("provisioning");
  });

  test("a successful link is transparent: onboarding proceeds normally", async () => {
    linkPhoneToUser.mockResolvedValue({ success: true });

    const result = await authedTrustedPhoneTurn();

    expect(linkPhoneToUser).toHaveBeenCalledWith("user-1", PHONE);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.provisioning.status).toBe("provisioning");
  });
});

describe("onboardingFetch — bounded hops fail closed and keep caller signals", () => {
  test("aborts a hung onboarding coordinator hop at the timeout", async () => {
    // A coordinator that never settles on its own: the only way out is the
    // caller's AbortSignal firing (the 10s default bounds internal hops).
    const hungStub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    };
    const start = Date.now();
    await expect(
      onboardingFetch(hungStub, "https://onboarding.internal/resolve", undefined, 100),
    ).rejects.toThrow(/aborted/i);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("keeps the deadline when a caller signal never aborts", async () => {
    let seen: AbortSignal | undefined;
    const stub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      },
    };
    const controller = new AbortController();
    await expect(
      onboardingFetch(
        stub,
        "https://onboarding.internal/resolve",
        { signal: controller.signal },
        100,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seen).not.toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  test("propagates caller cancellation through the composed signal", async () => {
    let seen: AbortSignal | undefined;
    const stub = {
      fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      },
    };
    const controller = new AbortController();
    const pending = onboardingFetch(stub, "https://onboarding.internal/resolve", {
      signal: controller.signal,
    });
    controller.abort(new DOMException("caller stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen?.aborted).toBe(true);
  });

  test("bounds a response body that never completes", async () => {
    let cancelled = false;
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    };
    await expect(
      onboardingFetch(stub, "https://onboarding.internal/resolve", undefined, 100),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancelled).toBe(true);
  });

  test("enforces the wall-clock deadline across immediately-ready empty chunks", async () => {
    let cancelled = false;
    let emitted = 0;
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted < 100_000) {
                emitted += 1;
                controller.enqueue(new Uint8Array(0));
                return;
              }
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    };
    const startedAt = performance.now();
    await expect(
      onboardingFetch(stub, "https://onboarding.internal/resolve", undefined, 1),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(emitted).toBeLessThan(100_000);
    expect(cancelled).toBe(true);
  });

  test("does not let a bodyless response win over caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller stopped after headers", "AbortError");
    const stub = {
      fetch: async () => {
        const response = new Response(null, { status: 204 });
        queueMicrotask(() => controller.abort(reason));
        return response;
      },
    };

    await expect(
      onboardingFetch(stub, "https://onboarding.internal/resolve", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  test("clears the deadline and caller listener after a successful bounded body read", async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const clearTimer = spyOn(globalThis, "clearTimeout");
    const removeListener = spyOn(controller.signal, "removeEventListener");
    const stub = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Response("{}");
      },
    };
    try {
      const response = await onboardingFetch(stub, "https://onboarding.internal/resolve", {
        signal: controller.signal,
      });
      expect(await response.json()).toEqual({});
      expect(seen?.aborted).toBe(false);
      expect(clearTimer).toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      clearTimer.mockRestore();
      removeListener.mockRestore();
    }
  });

  test("rejects an oversized body before returning it to a JSON caller", async () => {
    const stub = {
      fetch: async () =>
        new Response(new Uint8Array(1024 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
    };
    await expect(
      onboardingFetch(stub, "https://onboarding.internal/resolve"),
    ).rejects.toMatchObject({ code: "ONBOARDING_RESPONSE_TOO_LARGE" });
  });

  test("rejects and cancels a declared oversized body before reading", async () => {
    let cancelled = false;
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": String(1024 * 1024 + 1) } },
        ),
    };
    await expect(
      onboardingFetch(stub, "https://onboarding.internal/resolve"),
    ).rejects.toMatchObject({ code: "ONBOARDING_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  test("does not dispatch when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before dispatch");
    controller.abort(reason);
    const fetch = mock(async () => new Response("{}"));

    await expect(
      onboardingFetch({ fetch }, "https://onboarding.internal/resolve", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("preserves an explicit null caller-abort reason", async () => {
    const controller = new AbortController();
    controller.abort(null);
    const fetch = mock(async () => new Response("{}"));

    let rejection: unknown = Symbol("not rejected");
    try {
      await onboardingFetch({ fetch }, "https://onboarding.internal/resolve", {
        signal: controller.signal,
      });
    } catch (reason) {
      rejection = reason;
    }
    expect(rejection).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects an invalid deadline before dispatch", async () => {
    const fetch = mock(async () => new Response("{}"));
    await expect(
      onboardingFetch({ fetch }, "https://onboarding.internal/resolve", undefined, 0),
    ).rejects.toMatchObject({ code: "INVALID_ONBOARDING_TIMEOUT" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
