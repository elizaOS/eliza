import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const bootConfigState = vi.hoisted(() => ({
  config: {} as { apiToken?: string },
  globalToken: null as string | null,
}));

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

vi.mock("../config/boot-config", () => ({
  getBootConfig: () => bootConfigState.config,
  setBootConfig: vi.fn((config: { apiToken?: string }) => {
    bootConfigState.config = config;
  }),
}));

vi.mock("../utils/eliza-globals", () => ({
  getElizaApiToken: () => bootConfigState.globalToken,
  setElizaApiToken: vi.fn((token: string | null) => {
    bootConfigState.globalToken = token;
  }),
}));

const TEST_TIMEOUT_MS = 30_000;

describe("androidNativeAgentTransportForUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    capacitorState.isNative = true;
    capacitorState.platform = "android";
    bootConfigState.config = {};
    bootConfigState.globalToken = null;
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
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response?.json()).resolves.toEqual({ ready: true });
  });

  it(
    "keeps Android native-agent requests path-only across loopback aliases",
    async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { androidNativeAgentTransportForUrl } = await import(
        "./android-native-agent-transport"
      );

      for (const url of [
        "http://localhost:31337/api/health?source=localhost",
        "http://127.0.0.1:31337/api/health?source=ipv4",
        "http://[::1]:31337/api/health?source=ipv6",
      ]) {
        const transport = await androidNativeAgentTransportForUrl(url);
        expect(transport).toBeTruthy();
        await transport?.request(url, { method: "GET" });
      }

      expect(agentRequestMock).toHaveBeenCalledTimes(3);
      expect(agentRequestMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          path: "/api/health?source=localhost",
        }),
      );
      expect(agentRequestMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          path: "/api/health?source=ipv4",
        }),
      );
      expect(agentRequestMock).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          path: "/api/health?source=ipv6",
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "treats bracketed IPv6 loopback as an Android local-agent URL",
    async () => {
      const { isAndroidLocalAgentUrl } = await import(
        "../onboarding/local-agent-token"
      );

      expect(isAndroidLocalAgentUrl("http://[::1]:31337/api/status")).toBe(
        true,
      );
      expect(isAndroidLocalAgentUrl("eliza-local-agent://ipc/api/status")).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a structured local-unavailable response when Agent.request is missing",
    async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      capacitorState.plugins.Agent = {
        start: vi.fn(),
      };
      const { androidNativeAgentTransportForUrl } = await import(
        "./android-native-agent-transport"
      );

      const transport = await androidNativeAgentTransportForUrl(
        "http://127.0.0.1:31337/api/status",
      );
      const response = await transport?.request(
        "http://127.0.0.1:31337/api/status",
        { method: "GET" },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(agentRequestMock).not.toHaveBeenCalled();
      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toMatchObject({
        code: "local-unavailable",
        reason: "native-agent-request-unavailable",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not raw-fetch Android local-agent requests with unsupported bodies",
    async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { androidNativeAgentTransportForUrl } = await import(
        "./android-native-agent-transport"
      );

      const transport = await androidNativeAgentTransportForUrl(
        "http://127.0.0.1:31337/api/status",
      );
      const response = await transport?.request(
        "http://127.0.0.1:31337/api/status",
        {
          method: "POST",
          body: new FormData(),
        },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(agentRequestMock).not.toHaveBeenCalled();
      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toMatchObject({
        code: "local-unavailable",
        reason: "unsupported-request-body",
      });
    },
    TEST_TIMEOUT_MS,
  );

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
