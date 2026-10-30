import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeCloudSignInPort } from "@elizaos/auth/auth/native-cloud-sign-in";
import { NativeCloudSignInController } from "../native-cloud-sign-in-controller";

const attemptId = "6f1c2c63-6d7a-4bd6-9b6c-1f2d3e4a5b6c";
const authenticated = () => ({ status: "authenticated", environment: "production", expiresAt: Date.now() + 60_000, accountCreated: false });
function fixture(overrides: Partial<NativeCloudSignInPort<"production">> = {}) {
  const activate = vi.fn(async () => {}), abandoned = vi.fn();
  let current = true;
  const port: NativeCloudSignInPort<"production"> = {
    status: async () => ({ inApp: true, methodsKnown: true, email: true, google: true, phone: false }),
    startGoogle: vi.fn(async () => authenticated()),
    startEmail: vi.fn(async () => ({ attemptId, expiresAt: Date.now() + 60_000, resendAt: Date.now() + 1000 })),
    verifyEmail: vi.fn(async () => authenticated()), verifyMfa: vi.fn(async () => authenticated()),
    cancel: vi.fn(async () => {}), ...overrides,
  };
  const controller = new NativeCloudSignInController(port, { environment: "production", current: () => current, activate, abandoned });
  return { controller, port, activate, abandoned, retire: () => { current = false; } };
}
afterEach(() => vi.useRealTimers());

describe("shared native sign-in owner", () => {
  it("accepts a late positive readiness result only for its current unchanged chooser", async () => {
    vi.useFakeTimers();
    let answer!: (value: unknown) => void;
    const f = fixture({ status: () => new Promise(resolve => { answer = resolve; }) });
    const probe = f.controller.refreshReadiness();
    await vi.advanceTimersByTimeAsync(6000); await probe;
    expect(f.controller.getSnapshot().readiness).toBeNull();
    answer({ inApp: true, methodsKnown: true, email: true, google: true, phone: false });
    await Promise.resolve();
    expect(f.controller.getSnapshot().readiness).toMatchObject({ google: true });
    f.controller.dispose();
  });

  it.each(["owner", "operation", "method"])("rejects late readiness after %s changes", async change => {
    vi.useFakeTimers();
    let answer!: (value: unknown) => void;
    const f = fixture({ status: () => new Promise(resolve => { answer = resolve; }) });
    const probe = f.controller.refreshReadiness();
    await vi.advanceTimersByTimeAsync(6000); await probe;
    if (change === "owner") f.retire();
    if (change === "operation") f.controller.retireReadiness();
    if (change === "method") await f.controller.startEmail("owner@example.invalid");
    answer({ inApp: true, methodsKnown: true, email: true, google: true, phone: false });
    await Promise.resolve();
    expect(f.controller.getSnapshot().readiness).toBeNull();
    f.controller.dispose();
  });

  it("cancels a held native call promptly and ignores its late success", async () => {
    let answer!: (value: unknown) => void;
    const f = fixture({ startGoogle: () => new Promise(resolve => { answer = resolve; }) });
    const pending = f.controller.startGoogle();
    await f.controller.leave();
    await pending;
    answer(authenticated()); await Promise.resolve();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.abandoned).toHaveBeenCalledOnce();
    expect(f.port.cancel).toHaveBeenCalledOnce();
    expect(f.port.cancel).toHaveBeenCalledWith({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("requires acknowledged native retirement before dispatching another method", async () => {
    let active = false;
    const f = fixture({
      startGoogle: vi.fn(() => { active = true; return new Promise(() => {}); }),
      cancel: vi.fn(async () => { throw new Error("bridge disconnected before acknowledgement"); }),
      startEmail: vi.fn(async () => {
        if (active) throw { code: "login-active" };
        return { attemptId, expiresAt: Date.now() + 60_000, resendAt: Date.now() + 1000 };
      }),
    });
    const pending = f.controller.startGoogle();
    await f.controller.chooseAnotherMethod(); await pending;
    expect(f.controller.getSnapshot().error?.code).toBe("unavailable");
    await f.controller.startEmail("owner@example.invalid");
    expect(f.port.startEmail).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().error?.code).toBe("unavailable");
    vi.mocked(f.port.cancel).mockImplementation(async () => { active = false; });
    await f.controller.startEmail("owner@example.invalid");
    expect(f.port.startEmail).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({ step: { kind: "code" }, error: null, busy: false });
    f.controller.dispose();
  });

  it("retries account activation from the same authenticated outcome without another sign-in", async () => {
    const f = fixture();
    f.activate.mockRejectedValueOnce(new Error("readback offline"));
    await f.controller.startGoogle();
    expect(f.controller.getSnapshot()).toMatchObject({ stage: "activating", busy: false });
    await f.controller.retryActivation();
    expect(f.controller.getSnapshot().stage).toBe("complete");
    expect(f.activate).toHaveBeenCalledTimes(2);
    expect(f.port.startGoogle).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it("joins a retained completion to a held native request through account activation", async () => {
    let nativeAnswer!: (value: unknown) => void, activated!: () => void;
    let requestId = "";
    const f = fixture({ startGoogle: input => { requestId = input.requestId!; return new Promise(resolve => { nativeAnswer = resolve; }); } });
    let locked = false;
    const activate = vi.fn(() => new Promise<void>(resolve => { activated = resolve; }));
    const controller = new NativeCloudSignInController(f.port, {
      environment: "production", current: () => true, activate, abandoned: f.abandoned,
      runOperation: async (action, signal) => { locked = true; try { await action(signal); } finally { locked = false; } },
    });
    const native = controller.startGoogle();
    const returned = controller.acceptReturn({ ...authenticated(), requestId, attemptId, credentialId: attemptId });
    await Promise.resolve();
    expect(locked).toBe(true);
    expect(activate).toHaveBeenCalledOnce();
    activated(); await returned; await native;
    expect(locked).toBe(false);
    expect(controller.getSnapshot().stage).toBe("complete");
    nativeAnswer(authenticated()); await Promise.resolve();
    expect(activate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("does not cancel a successful host transaction when completion removes its view", async () => {
    const f = fixture();
    let cancelled = false;
    const controller = new NativeCloudSignInController(f.port, {
      environment: "production", current: () => true, activate: f.activate, abandoned: f.abandoned,
      runOperation: async (action, signal) => { await action(signal); cancelled = signal.aborted; },
    });
    controller.subscribe(() => { if (controller.getSnapshot().stage === "complete") queueMicrotask(() => controller.dispose()); });
    await controller.startGoogle();
    expect(cancelled).toBe(false);
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.port.cancel).not.toHaveBeenCalled();
  });

  it("joins the host operation and cannot publish when that operation is cancelled", async () => {
    let answer!: (value: unknown) => void;
    const f = fixture({ startGoogle: () => new Promise(resolve => { answer = resolve; }) });
    const host = new AbortController();
    const runOperation = vi.fn(async (action: (signal: AbortSignal) => Promise<void>) => action(host.signal));
    const controller = new NativeCloudSignInController(f.port, { environment: "production", current: () => true, activate: f.activate, abandoned: f.abandoned, runOperation });
    const pending = controller.startGoogle();
    host.abort(new DOMException("Host operation retired", "AbortError")); await pending;
    answer(authenticated()); await Promise.resolve();
    expect(runOperation).toHaveBeenCalledOnce();
    expect(f.activate).not.toHaveBeenCalled();
    controller.dispose();
  });
});


describe("native retained completion correlation", () => {
  it("rejects the cancelled controller's retained completion after closing and reopening", async () => {
    const listeners = new Set<(value: unknown) => void>();
    let request = "";
    const port: Partial<NativeCloudSignInPort<"production">> = {
      startGoogle: vi.fn(input => { request = Reflect.get(input, "requestId"); return new Promise(() => {}); }),
      cancel: vi.fn(async () => { throw new Error("bridge acknowledgement lost"); }),
      addListener: async (event, receive) => { if (event === "signInCompleted") listeners.add(receive); return { remove: async () => { listeners.delete(receive); } }; },
    };
    const old = fixture(port); old.controller.start();
    const pending = old.controller.startGoogle();
    await Promise.resolve();
    const oldRequest = request;
    old.controller.dispose(); await pending;
    const next = fixture(port); next.controller.start();
    await Promise.resolve();
    for (const receive of listeners) receive(authenticated());
    for (const receive of listeners) receive({ ...authenticated(), attemptId, credentialId: attemptId, requestId: oldRequest });
    await Promise.resolve(); await Promise.resolve();
    expect(next.activate).not.toHaveBeenCalled();
    expect(next.controller.getSnapshot().stage).toBe("choosing");
    next.controller.dispose();
  });

  it("accepts only this dispatched request, keeping native and credential identities", async () => {
    let request = "";
    const f = fixture({ startGoogle: vi.fn(input => { request = Reflect.get(input, "requestId"); return new Promise(() => {}); }) });
    const pending = f.controller.startGoogle(); await Promise.resolve();
    expect(request).toMatch(/^[0-9a-f-]{36}$/);
    const completion = { ...authenticated(), attemptId, credentialId: attemptId, requestId: request };
    await f.controller.acceptReturn({ ...completion, requestId: "deadbeef-dead-4eef-8ead-deadbeefdead" });
    await f.controller.acceptReturn(authenticated());
    expect(f.activate).not.toHaveBeenCalled();
    await f.controller.acceptReturn(completion); await pending;
    expect(f.activate).toHaveBeenCalledWith(completion, expect.any(AbortSignal));
    f.controller.dispose();
  });
});

describe("canonical broker completion teardown", () => {
  it("does not cancel the authenticated native attempt when broker publication unmounts the view", async () => {
    const { requestAndroidNativeCloudSignIn, getAndroidNativeCloudSignInRequest, activateAndroidNativeCloudSignIn, subscribeAndroidNativeCloudSignInRequest, resetAndroidNativeCloudSignInForTesting } = await import("../native-cloud-sign-in");
    resetAndroidNativeCloudSignInForTesting();
    const signedIn = requestAndroidNativeCloudSignIn("production", async () => {});
    const request = getAndroidNativeCloudSignInRequest()!;
    const f = fixture();
    const controller = new NativeCloudSignInController(f.port, {
      environment: "production", current: () => true, abandoned: f.abandoned,
      activate: (outcome, signal) => activateAndroidNativeCloudSignIn(request.id, outcome, signal),
    });
    const unsubscribe = subscribeAndroidNativeCloudSignInRequest(() => {
      if (!getAndroidNativeCloudSignInRequest()) controller.dispose();
    });
    try {
      await controller.startGoogle();
      await signedIn;
      expect(f.port.cancel).not.toHaveBeenCalled();
      expect(f.abandoned).not.toHaveBeenCalled();
    } finally { unsubscribe(); controller.dispose(); resetAndroidNativeCloudSignInForTesting(); }
  });
});


describe("native cancellation request correlation", () => {
  it("does not cancel another request when a readiness-only chooser closes", async () => {
    const cancel = vi.fn(async () => {});
    const old = fixture({ cancel });
    old.controller.start();
    old.controller.dispose();
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not cancel native while an aborted host operation is still awaiting admission", async () => {
    let admit!: () => void;
    const f = fixture();
    const controller = new NativeCloudSignInController(f.port, {
      environment: "production", current: () => true, activate: f.activate, abandoned: f.abandoned,
      runOperation: async (action, signal) => {
        await new Promise<void>(resolve => { admit = resolve; });
        await action(signal);
      },
    });
    const pending = controller.startGoogle();
    controller.dispose();
    admit();
    await pending;
    expect(f.port.startGoogle).not.toHaveBeenCalled();
    expect(f.port.cancel).not.toHaveBeenCalled();
  });

  it("keeps a newer native request when the old teardown reaches native late", async () => {
    let active: string | null = null;
    let deliverCancel!: () => void;
    const port = {
      startGoogle: vi.fn((input: { requestId?: string }) => {
        active = input.requestId!;
        return new Promise(() => {});
      }),
      cancel: vi.fn((input?: { requestId: string }) => new Promise<void>(resolve => {
        deliverCancel = () => {
          if (!input || input.requestId === active) active = null;
          resolve();
        };
      })),
    };
    const old = fixture(port);
    const original = old.controller.startGoogle();
    const oldRequest = active;
    old.controller.dispose();
    await original;
    // The old picker has ended independently while its renderer cancellation is delayed.
    active = null;
    const next = fixture(port);
    const current = next.controller.startGoogle();
    const nextRequest = active;
    expect(nextRequest).not.toBe(oldRequest);
    deliverCancel();
    await Promise.resolve();
    expect(active).toBe(nextRequest);
    expect(port.cancel).toHaveBeenCalledWith({ requestId: oldRequest });
    next.controller.dispose();
    deliverCancel();
    await current;
  });
});
