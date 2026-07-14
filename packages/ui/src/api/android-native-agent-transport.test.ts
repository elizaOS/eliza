/**
 * Unit coverage for the Android native agent transport: URL selection and the
 * native-bridge request path. Capacitor bridge mocked, no real device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../config/boot-config";
import {
  __resetAndroidNativeAgentTransportForTests,
  androidNativeAgentTransportForUrl,
  createAndroidNativeAgentTransport,
  installAndroidNativeAgentFetchBridge,
} from "./android-native-agent-transport";

const {
  capacitorState,
  agentRequestMock,
  registerPluginMock,
  runtimeRoutingState,
} = vi.hoisted(() => {
  const plugins: Record<string, unknown> = {};
  return {
    capacitorState: {
      isNative: true,
      platform: "android",
      plugins,
    },
    agentRequestMock: vi.fn(),
    registerPluginMock: vi.fn((name: string) => plugins[name]),
    runtimeRoutingState: {
      hasCloudSession: false,
      mode: null as string | null,
    },
  };
});

function stubChromiumWebViewCustomSchemeUrlParser(): void {
  const NativeUrl = globalThis.URL;
  class ChromiumWebViewUrl {
    private readonly inner: URL;
    private readonly raw: string;
    private readonly isIpc: boolean;

    constructor(input: string | URL, base?: string | URL) {
      this.raw = String(input);
      this.inner = new NativeUrl(input, base);
      this.isIpc = this.raw.toLowerCase().startsWith("eliza-local-agent://ipc");
    }

    get protocol(): string {
      return this.isIpc ? "eliza-local-agent:" : this.inner.protocol;
    }

    get href(): string {
      return this.toString();
    }

    get hostname(): string {
      return this.isIpc ? "" : this.inner.hostname;
    }

    get port(): string {
      return this.isIpc ? "" : this.inner.port;
    }

    get pathname(): string {
      if (!this.isIpc) return this.inner.pathname;
      const queryIndex = this.raw.indexOf("?");
      const withoutQuery =
        queryIndex === -1 ? this.raw : this.raw.slice(0, queryIndex);
      const suffix = withoutQuery.slice("eliza-local-agent://ipc".length);
      return `//ipc${suffix}`;
    }

    get search(): string {
      return this.isIpc ? this.inner.search : this.inner.search;
    }

    toString(): string {
      return this.isIpc ? this.raw : this.inner.toString();
    }
  }

  vi.stubGlobal("URL", ChromiumWebViewUrl);
}

function stubRuntimeMode(mode: string): void {
  runtimeRoutingState.mode = mode;
}

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

vi.mock("../first-run/android-local-agent-routing", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../first-run/android-local-agent-routing")
    >();
  return {
    ...actual,
    hasStoredAndroidCloudSession: () => runtimeRoutingState.hasCloudSession,
    readAndroidLocalAgentRuntimeMode: () => runtimeRoutingState.mode,
  };
});

describe("androidNativeAgentTransportForUrl", { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorState.isNative = true;
    capacitorState.platform = "android";
    runtimeRoutingState.hasCloudSession = false;
    runtimeRoutingState.mode = null;
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
    setBootConfig(DEFAULT_BOOT_CONFIG);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("extracts IPC paths correctly under Chromium WebView custom-scheme URL parsing", async () => {
    stubChromiumWebViewCustomSchemeUrlParser();
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

  it("does not install the Android local-agent transport for desktop loopback HTTP", async () => {
    capacitorState.isNative = false;
    capacitorState.platform = "web";

    await expect(
      androidNativeAgentTransportForUrl("http://127.0.0.1:31337/api/status"),
    ).resolves.toBeNull();
    expect(agentRequestMock).not.toHaveBeenCalled();
  });

  it("leaves adb-reversed loopback requests on HTTP in remote-mac mode", async () => {
    stubRuntimeMode("remote-mac");

    await expect(
      androidNativeAgentTransportForUrl("http://127.0.0.1:31337/api/status"),
    ).resolves.toBeNull();
    expect(registerPluginMock).not.toHaveBeenCalled();
    expect(agentRequestMock).not.toHaveBeenCalled();
  });

  it("keeps loopback requests on the native Agent plugin in local mode", async () => {
    stubRuntimeMode("local");

    const transport = await androidNativeAgentTransportForUrl(
      "http://127.0.0.1:31337/api/status",
    );
    const response = await transport?.request(
      "http://127.0.0.1:31337/api/status",
      { method: "GET" },
    );

    expect(agentRequestMock).toHaveBeenCalledOnce();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("keeps the explicit IPC identity native in remote-mac mode", async () => {
    stubRuntimeMode("remote-mac");

    const transport = await androidNativeAgentTransportForUrl(
      "eliza-local-agent://ipc/api/status",
    );
    const response = await transport?.request(
      "eliza-local-agent://ipc/api/status",
      { method: "GET" },
    );

    expect(agentRequestMock).toHaveBeenCalledOnce();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it("uses the original fetch for adb-reversed loopback in remote-mac mode", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ source: "adb-reverse-host" })),
    );
    stubRuntimeMode("remote-mac");
    vi.stubGlobal("fetch", fetchMock);

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("http://127.0.0.1:31337/api/status");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(agentRequestMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      source: "adb-reverse-host",
    });
  });

  it("bridges direct /api fetches through the native Agent plugin in Android local mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubRuntimeMode("local");

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

  it("does not bridge /api fetches to local when a cloud Steward token exists and no runtime mode is persisted", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ cloud: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        href: "https://app.elizacloud.ai/",
        origin: "https://app.elizacloud.ai",
      },
    });
    runtimeRoutingState.hasCloudSession = true;
    runtimeRoutingState.mode = "cloud";
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "eliza-local-agent://ipc",
    });

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("/api/status?source=direct", {
      method: "GET",
    });

    expect(agentRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({ cloud: true });
  });

  it("does not bridge absolute cloud-origin /api fetches in Android local mode", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ cloud: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", origin: "http://localhost" },
    });
    stubRuntimeMode("local");

    installAndroidNativeAgentFetchBridge();

    const response = await fetch("https://api.elizacloud.ai/api/v1/agents", {
      method: "GET",
    });

    expect(agentRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({ cloud: true });
  });

  it("bridges direct /api fetches when the configured Android base is IPC", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: { href: "http://localhost/" },
    });
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "eliza-local-agent://ipc",
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

  it("bridges IPC fetches under Chromium WebView custom-scheme URL parsing", async () => {
    stubChromiumWebViewCustomSchemeUrlParser();
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
