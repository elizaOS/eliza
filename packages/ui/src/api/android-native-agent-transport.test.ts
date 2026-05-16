import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAndroidNativeAgentTransportForTests,
  androidNativeAgentTransportForUrl,
  createAndroidNativeAgentTransport,
  installAndroidNativeAgentFetchBridge,
} from "./android-native-agent-transport";

const { capacitorState, agentRequestMock, registerPluginMock } = vi.hoisted(
  () => {
    const plugins: Record<string, unknown> = {};
    return {
      capacitorState: {
        isNative: true,
        platform: "android",
        plugins,
      },
      agentRequestMock: vi.fn(),
      registerPluginMock: vi.fn((name: string) => plugins[name]),
    };
  },
);

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

describe("androidNativeAgentTransportForUrl", { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorState.isNative = true;
    capacitorState.platform = "android";
    capacitorState.plugins.Agent = {
      request: agentRequestMock,
    };
    agentRequestMock.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ready: true }),
    });
  });

  afterEach(() => {
    __resetAndroidNativeAgentTransportForTests();
    globalThis.localStorage?.removeItem("eliza:mobile-runtime-mode");
    vi.unstubAllGlobals();
  });

  it("routes Android local-agent requests through the native Agent plugin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = createAndroidNativeAgentTransport({
      request: agentRequestMock,
    });

    expect(transport).toBeTruthy();
    const response = await transport.request(
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
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("routes the IPC local-agent identity through the native Agent plugin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const transport = createAndroidNativeAgentTransport({
      request: agentRequestMock,
    });

    const response = await transport.request(
      "eliza-local-agent://ipc/api/status?source=test",
      { method: "GET" },
      { timeoutMs: 12_345 },
    );

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/status?source=test",
      headers: {},
      body: null,
      timeoutMs: 12_345,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("does not install the Android local-agent transport on iOS", async () => {
    capacitorState.platform = "ios";

    await expect(
      androidNativeAgentTransportForUrl("http://127.0.0.1:31337/api/status"),
    ).resolves.toBeNull();
    await expect(
      androidNativeAgentTransportForUrl(
        "eliza-local-agent://ipc/api/auth/status",
      ),
    ).resolves.toBeNull();
  });

  it("bridges direct /api fetches through the native Agent plugin in Android local mode", async () => {
    const fetchMock = vi.fn();
    const storage = new Map<string, string>();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    });
    globalThis.localStorage.setItem("eliza:mobile-runtime-mode", "local");

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("/api/status?source=direct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ping: true }),
    });

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/status?source=direct",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ping: true }),
      timeoutMs: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("bridges direct /api fetches when the configured Android base is IPC", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
      __ELIZA_API_BASE__: "eliza-local-agent://ipc",
    });

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("/api/health", { method: "GET" });

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/health",
      headers: {},
      body: null,
      timeoutMs: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("bridges the IPC URL when Capacitor reports android but isNativePlatform is false", async () => {
    capacitorState.isNative = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("eliza-local-agent://ipc/api/auth/status", {
      method: "GET",
    });

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/auth/status",
      headers: {},
      body: null,
      timeoutMs: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ready: true });
  });

  it("bridges the IPC URL through the Agent plugin before Capacitor reports the Android platform", async () => {
    capacitorState.isNative = false;
    capacitorState.platform = "web";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const transport = await androidNativeAgentTransportForUrl(
      "eliza-local-agent://ipc/api/auth/status",
    );
    expect(transport).toBeTruthy();
    const response = await transport?.request(
      "eliza-local-agent://ipc/api/auth/status",
      { method: "GET" },
    );

    expect(agentRequestMock).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/auth/status",
      headers: {},
      body: null,
      timeoutMs: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("returns a structured 503 for IPC fetches when the native Agent request bridge is unavailable", async () => {
    capacitorState.isNative = false;
    capacitorState.platform = "web";
    delete capacitorState.plugins.Agent;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("eliza-local-agent://ipc/api/auth/status", {
      method: "GET",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "native_agent_unavailable",
    });
  });
});
