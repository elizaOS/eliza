/**
 * Pins onboarding phone-link and internal-hop failures with deterministic
 * service fixtures and transport streams; no live model or network is used.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as realCloudBindings from "../../runtime/cloud-bindings";
import * as provisioningObservation from "./provisioning-observation";

const sessionCache = new Map<string, unknown>();
const getElizaAppProvisioningStatus = mock();
const linkPhoneToUser = mock();
const launchManagedElizaAgent = mock();
let cloudEnv: Record<string, string | undefined> = {};
const REAL_CLOUD_BINDINGS = { ...realCloudBindings };

const cacheClientActualModule = await import("../../cache/client");

mock.module("../../cache/client", () => ({
  ...cacheClientActualModule,
  cache: {
    get: mock(async (key: string) => sessionCache.get(key) ?? null),
    set: mock(async (key: string, value: unknown) => {
      sessionCache.set(key, value);
    }),
    delConfirmed: async () => true,
    delPatternConfirmed: async () => true,
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
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    let confirmCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      confirmCancellation = resolve;
    });
    let emitted = 0;
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (emitted < 100_000) {
                  emitted += 1;
                  now += 0.25;
                  controller.enqueue(new Uint8Array(0));
                  return;
                }
                controller.close();
              },
              cancel() {
                confirmCancellation();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    };
    try {
      // Advance only when the owned reader requests a chunk. Cold imports or
      // scheduling before dispatch must not replace the starvation scenario.
      await expect(
        onboardingFetch(stub, "https://onboarding.internal/resolve", undefined, 1),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(emitted).toBeGreaterThan(0);
      expect(emitted).toBeLessThan(100_000);
      // The abort race may settle before the reader's cancellation microtask.
      await cancellation;
    } finally {
      clock.mockRestore();
    }
  });

  test("lets the real deadline run across ready chunks when the Worker clock is frozen", async () => {
    const realNow = performance.now.bind(performance);
    const clock = spyOn(performance, "now").mockReturnValue(0);
    let sourceEndsAt = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            // Finite even before the fix: the source closes after real CPU time.
            if (realNow() >= sourceEndsAt) controller.close();
            else {
              controller.enqueue(new Uint8Array(0));
            }
          },
        },
        { highWaterMark: 0 },
      ),
    );
    try {
      await expect(
        onboardingFetch(
          {
            fetch: async () => {
              sourceEndsAt = realNow() + 50;
              return response;
            },
          },
          "https://onboarding.internal/resolve",
          undefined,
          5,
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      clock.mockRestore();
    }
  });

  test("checks the real deadline before returning a bodyless response with a frozen Worker clock", async () => {
    const realNow = performance.now.bind(performance);
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
      await expect(
        onboardingFetch(
          {
            fetch: async () => {
              const end = realNow() + 20;
              while (realNow() < end) {
                // A synchronous transport turn cannot yield to the deadline.
              }
              return new Response(null, { status: 204 });
            },
          },
          "https://onboarding.internal/resolve",
          undefined,
          5,
        ),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      clock.mockRestore();
    }
  });

  test("preserves every ordered byte across task-queue yields", async () => {
    const expected = Uint8Array.from({ length: 4_096 }, (_, index) => index % 251);
    let offset = 0;
    const response = await onboardingFetch(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset === expected.length) controller.close();
                else controller.enqueue(expected.subarray(offset, ++offset));
              },
            }),
            {
              status: 201,
              headers: { "content-type": "application/octet-stream", "x-trace-id": "ordered-body" },
            },
          ),
      },
      "https://onboarding.internal/resolve",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-trace-id")).toBe("ordered-body");
  });

  test("preserves the caller's exact reason when its timer interrupts ready chunks", async () => {
    const clock = spyOn(performance, "now").mockReturnValue(0);
    const caller = new AbortController();
    const reason = new Error("caller cancelled a ready stream", {
      cause: new Error("session ended"),
    });
    let emitted = 0;
    const cancelled: unknown[] = [];
    const timer = setTimeout(() => caller.abort(reason), 0);
    try {
      await expect(
        onboardingFetch(
          {
            fetch: async () =>
              new Response(
                new ReadableStream<Uint8Array>(
                  {
                    pull(controller) {
                      if (emitted === 4_096) controller.close();
                      else {
                        emitted += 1;
                        controller.enqueue(new Uint8Array(0));
                      }
                    },
                    cancel(cancelReason) {
                      cancelled.push(cancelReason);
                    },
                  },
                  { highWaterMark: 0 },
                ),
              ),
          },
          "https://onboarding.internal/resolve",
          { signal: caller.signal },
        ),
      ).rejects.toBe(reason);
      expect(cancelled).toEqual([reason]);
      expect(emitted).toBeLessThan(4_096);
    } finally {
      clearTimeout(timer);
      clock.mockRestore();
    }
  });

  test("cancels a response acquired after its monotonic deadline without awaiting teardown", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const cancellationReasons: unknown[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationReasons.push(reason);
          return new Promise<void>(() => {});
        },
      }),
    );
    let rejection: unknown;
    try {
      await onboardingFetch(
        {
          fetch: async () => {
            // Headers arrive after the budget, before a reader owns the body.
            now = 2;
            return response;
          },
        },
        "https://onboarding.internal/resolve",
        undefined,
        1,
      ).catch((error) => {
        rejection = error;
      });
    } finally {
      clock.mockRestore();
    }
    expect(rejection).toMatchObject({ name: "TimeoutError" });
    expect(cancellationReasons).toEqual([rejection]);
    expect(response.body?.locked).toBe(false);
  });

  test("cancels a late response from a transport that ignores caller cancellation", async () => {
    let releaseResponse!: (response: Response) => void;
    const headers = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const cancellationReasons: unknown[] = [];
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel(reason) {
          cancellationReasons.push(reason);
          throw new Error("transport cancellation failed");
        },
      }),
    );
    const controller = new AbortController();
    const pending = onboardingFetch(
      { fetch: () => headers },
      "https://onboarding.internal/resolve",
      { signal: controller.signal },
    );
    const reason = new Error("caller stopped before headers");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    releaseResponse(response);
    await headers;
    // Let the response observer finish independently of the failed caller.
    await Promise.resolve();
    expect(cancellationReasons).toEqual([reason]);
    expect(response.body?.locked).toBe(false);
  });

  test("preserves the caller reason when stream cancellation rejects differently", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller owns this reason", "AbortError");
    const transportFailure = new Error("transport cancellation failed");
    let releasePull!: () => void;
    const blockedPull = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull() {
              await blockedPull;
            },
            cancel() {
              throw transportFailure;
            },
          }),
        ),
    };

    const pending = onboardingFetch(stub, "https://onboarding.internal/resolve", {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(reason);
    releasePull();

    await expect(pending).rejects.toBe(reason);
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

  test("bounds retained storage across many one-byte transport chunks", async () => {
    const chunkCount = 16_384;
    let emitted = 0;
    const stub = {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted === chunkCount) {
                controller.close();
                return;
              }
              emitted += 1;
              controller.enqueue(Uint8Array.of(97));
            },
          }),
        ),
    };

    const response = await onboardingFetch(stub, "https://onboarding.internal/resolve");
    expect((await response.arrayBuffer()).byteLength).toBe(chunkCount);
    expect(emitted).toBe(chunkCount);
  });

  test("drops decoded representation headers when returning the buffered body", async () => {
    const stub = {
      fetch: async () =>
        new Response("decoded", {
          headers: {
            "content-encoding": "gzip",
            "content-length": "1",
            "content-type": "application/json",
            trailer: "content-digest",
            "transfer-encoding": "chunked",
            "x-request-id": "request-1",
          },
        }),
    };

    const response = await onboardingFetch(stub, "https://onboarding.internal/resolve");
    expect(await response.text()).toBe("decoded");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("trailer")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("request-1");
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
