import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({
  isNative: true,
  platform: "ios",
  pluginAvailable: false,
}));

const buildVariantState = vi.hoisted(() => ({
  isStore: false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorState.platform,
    isPluginAvailable: () => capacitorState.pluginAvailable,
    isNativePlatform: () => capacitorState.isNative,
  },
  registerPlugin: vi.fn(),
}));

vi.mock("../build-variant", () => ({
  isStoreBuild: () => buildVariantState.isStore,
}));

vi.mock("./ios-local-agent-kernel", () => ({
  handleIosLocalAgentRequest: vi.fn(),
  startIosLocalAgentKernel: vi.fn(),
}));

describe("iOS local agent transport (ui copy)", () => {
  beforeEach(() => {
    vi.resetModules();
    capacitorState.isNative = true;
    capacitorState.platform = "ios";
    capacitorState.pluginAvailable = false;
    buildVariantState.isStore = false;
    vi.stubGlobal("window", {
      location: { href: "capacitor://localhost/" },
      navigator: { userAgent: "vitest" },
    });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
    });
  });

  afterEach(() => {
    vi.doUnmock("@elizaos/capacitor-bun-runtime");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does NOT deadlock when the plugin module exports a raw Capacitor proxy (hostile `then`) — #11030 device boot hang", async () => {
    // Faithful reproduction of @capacitor/core's registerPlugin proxy: the
    // get trap fabricates a method wrapper for ANY property — including
    // `then` — and a wrapper for a method missing from the native plugin
    // header produces a promise that REJECTS without ever invoking the
    // (resolve, reject) arguments. `await`ing such a proxy therefore never
    // settles. The transport must never let this proxy cross an await.
    //
    // Guard mechanics: on the real device the fabricated `then` never calls
    // its callbacks, so the await hangs forever. Detecting that hang with a
    // wall-clock Promise.race flaked under a CPU-saturated parallel suite
    // (the 10s timer beat the starved microtask chain ~1 run in 4), so the
    // guard is now DETERMINISTIC: promise assimilation calling the proxy's
    // fabricated `then` at all proves the raw proxy crossed an await — the
    // exact regression — and the hostile `then` rejects that await instantly
    // with the descriptive #11030 error instead of simulating the hang and
    // timing it.
    const start = vi.fn(async () => ({ ok: true }));
    const getStatus = vi.fn(async () => ({ ready: true, engine: "bun" }));
    const call = vi.fn(async () => ({
      result: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      },
    }));
    const nativeMethods: Record<string, (...args: unknown[]) => unknown> = {
      start,
      getStatus,
      call,
    };
    let rawProxyThenInvocations = 0;
    const capacitorLikeProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "$$typeof") return undefined;
          if (prop === "toJSON") return () => ({});
          if (prop === "then") {
            // Awaiting the proxy (the #11030 regression) assimilates it as a
            // thenable and invokes this wrapper with (resolve, reject). Fail
            // that await loudly and deterministically.
            return (...args: unknown[]) => {
              rawProxyThenInvocations += 1;
              const reject = args[1];
              const error = new Error(
                "deadlock: transport awaited the raw Capacitor plugin proxy (#11030)",
              );
              if (typeof reject === "function") {
                reject(error);
                return;
              }
              throw error;
            };
          }
          return (...args: unknown[]) => {
            const fn = nativeMethods[String(prop)];
            if (fn) return fn(...args);
            const p = Promise.reject(
              new Error(`"${String(prop)}()" is not implemented on ios`),
            );
            // Capacitor's wrapper promise is unobserved by the thenable
            // assimilation machinery; keep vitest quiet about it the same way.
            p.catch(() => {});
            return p;
          };
        },
      },
    );
    capacitorState.pluginAvailable = true;
    vi.stubEnv("VITE_ELIZA_IOS_FULL_BUN_STRICT", "1");
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "eliza:mobile-runtime-mode" ? "local" : null,
    });
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: capacitorLikeProxy,
    }));

    const { handleIosLocalAgentNativeRequest } = await import(
      "./ios-local-agent-transport"
    );

    // Pre-fix, the transport returned the raw proxy from an async helper, so
    // this await rejects with the descriptive deadlock error above (via the
    // hostile `then`). Post-fix the proxy is wrapped into a plain bound-method
    // object before any await, `then` is never touched, and the request
    // resolves normally.
    const result = await handleIosLocalAgentNativeRequest({
      method: "GET",
      path: "/api/auth/status",
    });

    expect(rawProxyThenInvocations).toBe(0);
    expect(result.status).toBe(200);
    expect(getStatus).toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ method: "http_request" }),
    );
    // Generous ceiling: the deadlock guard above is deterministic (a regression
    // rejects instantly via the hostile `then`), so this timeout only has to
    // outlast the in-test `await import` transform of the transport graph,
    // which can exceed 30s when the full parallel suite saturates the machine.
  }, 120_000);

  it("records boot progress phases for the startup poll's progress-aware budget", async () => {
    const start = vi.fn(async () => ({ ok: true }));
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValue({ ready: true, engine: "bun" });
    const call = vi.fn(async () => ({
      result: {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false }),
      },
    }));
    capacitorState.pluginAvailable = true;
    vi.stubEnv("VITE_ELIZA_IOS_FULL_BUN_STRICT", "1");
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "eliza:mobile-runtime-mode" ? "local" : null,
    });
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: { start, getStatus, call },
    }));

    const {
      handleIosLocalAgentNativeRequest,
      getIosNativeAgentBootProgress,
      isIosNativeAgentBootInProgress,
      resetIosNativeAgentBootProgressForTests,
    } = await import("./ios-local-agent-transport");
    resetIosNativeAgentBootProgressForTests();

    const result = await handleIosLocalAgentNativeRequest({
      method: "GET",
      path: "/api/auth/status",
    });

    // A structured 503 from the mid-boot kernel is a heartbeat, and the
    // engine start flipped the phase to ready — both feed the startup poll's
    // progress-aware consecutive-failure budget.
    expect(result.status).toBe(503);
    expect(start).toHaveBeenCalledTimes(1);
    expect(getIosNativeAgentBootProgress().phase).toBe("ready");
    expect(isIosNativeAgentBootInProgress()).toBe(true);
  }, 120_000);

  it("allows explicit simulator loopback fetches in cloud mode on non-local-agent ports", async () => {
    vi.stubEnv("VITE_ELIZA_IOS_ALLOW_SIMULATOR_LOOPBACK", "1");
    const originalFetch = vi.fn(async () => new Response('{"ready":true}'));
    vi.stubGlobal("fetch", originalFetch);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "eliza:mobile-runtime-mode" ? "cloud-hybrid" : null,
    });
    vi.stubGlobal("window", {
      __ELIZA_API_BASE__: "https://www.elizacloud.ai",
      location: { href: "capacitor://localhost/" },
      navigator: { userAgent: "vitest" },
    });

    const { installIosLocalAgentFetchBridge } = await import(
      "./ios-local-agent-transport"
    );
    installIosLocalAgentFetchBridge();

    const response = await fetch("http://127.0.0.1:31338/api/health");

    await expect(response.json()).resolves.toEqual({ ready: true });
    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});
