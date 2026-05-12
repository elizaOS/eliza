import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({
  isNative: true,
  platform: "ios",
  pluginAvailable: false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorState.platform,
    isPluginAvailable: () => capacitorState.pluginAvailable,
    isNativePlatform: () => capacitorState.isNative,
  },
}));

describe("iOS local agent transport bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    capacitorState.isNative = true;
    capacitorState.platform = "ios";
    capacitorState.pluginAvailable = false;
    vi.stubGlobal("window", {
      location: { href: "capacitor://localhost/" },
      navigator: { userAgent: "vitest" },
    });
  });

  afterEach(() => {
    vi.doUnmock("@elizaos/capacitor-bun-runtime");
    vi.unstubAllGlobals();
  });

  it("installs a native-callable path-only request handler", async () => {
    const { installIosLocalAgentNativeRequestBridge } = await import(
      "./ios-local-agent-transport"
    );
    installIosLocalAgentNativeRequestBridge();

    const handler = window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__;
    expect(handler).toBeTypeOf("function");

    const response = await handler?.({
      method: "GET",
      path: "/api/local-agent/capabilities",
      timeoutMs: 1234,
    });

    expect(response?.status).toBe(200);
    expect(response?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({
      mode: "ios-local",
      transport: {
        foreground: "ittp",
      },
    });
  }, 30_000);

  it("routes loopback local-agent URLs through the ITTP transport", async () => {
    const { iosInProcessAgentTransportForUrl } = await import(
      "./ios-local-agent-transport"
    );

    const transport = await iosInProcessAgentTransportForUrl(
      "http://127.0.0.1:31337/api/health",
    );
    expect(transport).toBeTruthy();

    const response = await transport?.request(
      "http://127.0.0.1:31337/api/health",
      { method: "GET" },
    );

    await expect(response?.json()).resolves.toMatchObject({
      localAgent: {
        mode: "ios-local",
        transport: "ittp",
      },
    });
  });

  it("bridges direct relative fetch calls when iOS local mode owns the API base", async () => {
    const originalFetch = vi.fn(async () => {
      throw new Error("direct fetch should not run");
    });
    vi.stubGlobal("fetch", originalFetch);
    vi.stubGlobal("window", {
      __ELIZA_API_BASE__: "http://127.0.0.1:31337",
      location: { href: "capacitor://localhost/" },
      navigator: { userAgent: "vitest" },
    });

    const { installIosLocalAgentFetchBridge } = await import(
      "./ios-local-agent-transport"
    );
    installIosLocalAgentFetchBridge();

    const response = await fetch("/api/local-agent/capabilities");

    expect(originalFetch).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      mode: "ios-local",
    });
  });

  it("uses an already-running full Bun native bridge when the runtime plugin is available", async () => {
    capacitorState.pluginAvailable = true;
    const start = vi.fn(async () => ({ ok: true }));
    const getStatus = vi.fn(async () => ({ ready: true, engine: "bun" }));
    const call = vi.fn(async () => ({
      result: {
        status: 202,
        statusText: "Accepted",
        headers: { "x-engine": "bun" },
        body: '{"ok":true}',
      },
    }));
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: { start, getStatus, call },
    }));

    const { handleIosLocalAgentNativeRequest } = await import(
      "./ios-local-agent-transport"
    );
    const response = await handleIosLocalAgentNativeRequest({
      method: "POST",
      path: "/api/full-bun-smoke",
      headers: { "content-type": "application/json" },
      body: '{"hello":"ios"}',
    });

    expect(start).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith({
      method: "http_request",
      args: expect.objectContaining({
        method: "POST",
        path: "/api/full-bun-smoke",
        body: '{"hello":"ios"}',
      }),
    });
    expect(response).toMatchObject({
      status: 202,
      headers: { "x-engine": "bun" },
      body: '{"ok":true}',
    });
  });

  it("starts the full Bun native bridge when the runtime plugin is available but not running", async () => {
    capacitorState.pluginAvailable = true;
    const start = vi.fn(async () => ({ ok: true }));
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValueOnce({ ready: true, engine: "bun" });
    const call = vi.fn(async () => ({
      result: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
    }));
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: { start, getStatus, call },
    }));

    const { handleIosLocalAgentNativeRequest } = await import(
      "./ios-local-agent-transport"
    );
    const response = await handleIosLocalAgentNativeRequest({
      method: "GET",
      path: "/api/health",
    });

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "bun" }),
    );
    expect(response).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
  });

  it("requires the full Bun bridge during the in-app smoke even if Capacitor platform detection is early", async () => {
    capacitorState.isNative = false;
    const start = vi.fn(async () => ({ ok: true }));
    const getStatus = vi.fn(async () => ({ ready: true, engine: "bun" }));
    const call = vi.fn(async () => ({
      result: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: '{"ready":true}',
      },
    }));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "eliza:ios-full-bun-smoke:request" ? "1" : null,
    });
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: { start, getStatus, call },
    }));

    const { handleIosLocalAgentNativeRequest } = await import(
      "./ios-local-agent-transport"
    );
    const response = await handleIosLocalAgentNativeRequest({
      path: "/api/health",
    });

    expect(call).toHaveBeenCalledWith({
      method: "http_request",
      args: expect.objectContaining({ path: "/api/health" }),
    });
    expect(response.status).toBe(200);
  });

  it("does not await Capacitor plugin proxies that expose a then member", async () => {
    capacitorState.pluginAvailable = true;
    const getStatus = vi.fn(async () => ({ ready: true, engine: "bun" }));
    const call = vi.fn(async () => ({
      result: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      },
    }));
    const then = vi.fn();
    vi.doMock("@elizaos/capacitor-bun-runtime", () => ({
      ElizaBunRuntime: {
        start: vi.fn(async () => ({ ok: true })),
        getStatus,
        call,
        then,
      },
    }));

    const { handleIosLocalAgentNativeRequest, primeIosFullBunRuntime } =
      await import("./ios-local-agent-transport");
    primeIosFullBunRuntime({
      start: vi.fn(async () => ({ ok: true })),
      getStatus,
      call,
      then,
    } as never);

    const response = await handleIosLocalAgentNativeRequest({
      method: "GET",
      path: "/api/health",
    });

    expect(then).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("rejects absolute paths from the native request bridge", async () => {
    const { handleIosLocalAgentNativeRequest } = await import(
      "./ios-local-agent-transport"
    );

    await expect(
      handleIosLocalAgentNativeRequest({
        path: "https://agent.example/api/status",
      }),
    ).rejects.toThrow("path that starts with /");
  });
});
