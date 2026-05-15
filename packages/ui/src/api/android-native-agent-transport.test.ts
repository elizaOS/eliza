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

const TEST_TIMEOUT_MS = 30_000;

describe("androidNativeAgentTransportForUrl", () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.unstubAllGlobals();
  });

  it(
    "routes Android local-agent requests through the native Agent plugin",
    async () => {
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
    },
    TEST_TIMEOUT_MS,
  );

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
      ]) {
        const transport = await androidNativeAgentTransportForUrl(url);
        expect(transport).toBeTruthy();
        await transport?.request(url, { method: "GET" });
      }

      expect(agentRequestMock).toHaveBeenCalledTimes(2);
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
      for (const call of agentRequestMock.mock.calls) {
        expect(call[0]).not.toHaveProperty("url");
        expect(call[0].path).toMatch(/^\/api\//);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not install the Android local-agent transport on iOS",
    async () => {
      capacitorState.platform = "ios";
      const { androidNativeAgentTransportForUrl } = await import(
        "./android-native-agent-transport"
      );

      await expect(
        androidNativeAgentTransportForUrl("http://127.0.0.1:31337/api/status"),
      ).resolves.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not treat the iOS IPC identity as an Android local-agent URL",
    async () => {
      const { androidNativeAgentTransportForUrl } = await import(
        "./android-native-agent-transport"
      );

      await expect(
        androidNativeAgentTransportForUrl("eliza-local-agent://ipc/api/status"),
      ).resolves.toBeNull();
      expect(agentRequestMock).not.toHaveBeenCalled();
    },
    TEST_TIMEOUT_MS,
  );
});
