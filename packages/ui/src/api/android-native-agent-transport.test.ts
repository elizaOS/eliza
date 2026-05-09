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
