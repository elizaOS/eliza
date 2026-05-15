import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorState, agentStartMock, agentRequestMock, registerPluginMock } =
  vi.hoisted(() => {
    const plugins: Record<string, unknown> = {};
    return {
      capacitorState: {
        isNative: true,
        platform: "android",
        plugins,
      },
      agentStartMock: vi.fn(),
      agentRequestMock: vi.fn(),
      registerPluginMock: vi.fn((name: string) => plugins[name]),
    };
  });

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    get Plugins() {
      return capacitorState.plugins;
    },
    getPlatform: () => capacitorState.platform,
    isNativePlatform: () => capacitorState.isNative,
    registerPlugin: registerPluginMock,
  },
}));

describe("androidNativeAgentTransportForUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    capacitorState.isNative = true;
    capacitorState.platform = "android";
    capacitorState.plugins.Agent = {
      start: agentStartMock,
      request: agentRequestMock,
    };
    agentStartMock.mockResolvedValue({
      state: "starting",
      agentName: null,
      port: 31337,
      startedAt: null,
      error: null,
    });
    agentRequestMock.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes Android local-agent requests through the native Agent plugin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { androidNativeAgentTransportForUrl } = await import(
      "./android-native-agent-transport"
    );

    const transport = await androidNativeAgentTransportForUrl(
      "http://127.0.0.1:31337/api/status?source=test",
    );

    expect(transport).toBeTruthy();
    const response = await transport?.request(
      "http://127.0.0.1:31337/api/status?source=test",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer local-token",
        },
        body: JSON.stringify({ ping: true }),
      },
      { timeoutMs: 12_345 },
    );

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/status?source=test",
      headers: {
        authorization: "Bearer local-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ping: true }),
      timeoutMs: 12_345,
    });
    expect(agentStartMock).toHaveBeenCalledWith({
      apiBase: "http://127.0.0.1:31337",
      mode: "local",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("routes bracketed IPv6 loopback through the same native bridge", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { androidNativeAgentTransportForUrl } = await import(
      "./android-native-agent-transport"
    );

    const transport = await androidNativeAgentTransportForUrl(
      "http://[::1]:31337/api/status",
    );

    const response = await transport?.request(
      "http://[::1]:31337/api/status",
      { method: "GET" },
      { timeoutMs: 1000 },
    );

    expect(agentStartMock).toHaveBeenCalledWith({
      apiBase: "http://[::1]:31337",
      mode: "local",
    });
    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/status",
      headers: {},
      body: null,
      timeoutMs: 1000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response?.status).toBe(200);
  });

  it("returns a structured 503 when native Agent.request is unavailable", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("ok", {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    capacitorState.plugins.Agent = {
      start: agentStartMock,
    };
    const { androidNativeAgentTransportForUrl } = await import(
      "./android-native-agent-transport"
    );

    const transport = await androidNativeAgentTransportForUrl(
      "http://127.0.0.1:31337/api/upload",
    );

    const body = new Blob(["payload"]);
    const response = await transport?.request(
      "http://127.0.0.1:31337/api/upload",
      {
        method: "POST",
        body,
      },
      { timeoutMs: 1000 },
    );

    expect(agentStartMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      error: "android_native_agent_request_unavailable",
    });
  });

  it("rejects unsupported local request bodies instead of using raw loopback fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { androidNativeAgentTransportForUrl } = await import(
      "./android-native-agent-transport"
    );

    const transport = await androidNativeAgentTransportForUrl(
      "http://127.0.0.1:31337/api/upload",
    );

    const response = await transport?.request(
      "http://127.0.0.1:31337/api/upload",
      {
        method: "POST",
        body: new Blob(["payload"]),
      },
      { timeoutMs: 1000 },
    );

    expect(agentStartMock).not.toHaveBeenCalled();
    expect(agentRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response?.status).toBe(415);
    await expect(response?.json()).resolves.toMatchObject({
      ok: false,
      error: "android_native_agent_unsupported_body",
    });
  });

  it("canonicalizes lifecycle starts with the Android local API base", async () => {
    const { androidNativeAgentLifecycleForUrl } = await import(
      "./android-native-agent-transport"
    );

    const lifecycle = await androidNativeAgentLifecycleForUrl(
      "http://127.0.0.2:31337/api/status",
    );
    const status = await lifecycle?.start?.();

    expect(status).toEqual({
      state: "starting",
      agentName: null,
      port: 31337,
      startedAt: null,
      error: null,
    });
    expect(agentStartMock).toHaveBeenCalledWith({
      apiBase: "http://127.0.0.2:31337",
      mode: "local",
    });
  });

  it("does not install the Android local-agent transport on iOS", async () => {
    capacitorState.platform = "ios";
    const { androidNativeAgentTransportForUrl } = await import(
      "./android-native-agent-transport"
    );

    await expect(
      androidNativeAgentTransportForUrl("http://127.0.0.1:31337/api/status"),
    ).resolves.toBeNull();
  });
});
