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
    const capacitorLikeProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "$$typeof") return undefined;
          if (prop === "toJSON") return () => ({});
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

    // Pre-fix this await hangs forever (the raw proxy was returned from an
    // async helper and its fake `then` swallowed the resolution). Bound the
    // regression with a real-time race so a reintroduced deadlock fails
    // loudly instead of timing out the whole suite.
    const result = await Promise.race([
      handleIosLocalAgentNativeRequest({
        method: "GET",
        path: "/api/auth/status",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                "deadlock: transport awaited the raw Capacitor plugin proxy (#11030)",
              ),
            ),
          10_000,
        );
      }),
    ]);

    expect(result.status).toBe(200);
    expect(getStatus).toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ method: "http_request" }),
    );
  }, 30_000);

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
  }, 30_000);
});
