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

import {
  clearLocalAgentProbeCache,
  probeLocalAgent,
} from "./probe-local-agent";

describe("probeLocalAgent", () => {
  beforeEach(() => {
    clearLocalAgentProbeCache();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    capacitorState.isNative = true;
    capacitorState.platform = "android";
    capacitorState.plugins.Agent = {
      request: agentRequestMock,
    };
    agentRequestMock.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ ready: true }),
    });
  });

  afterEach(() => {
    clearLocalAgentProbeCache();
    vi.unstubAllGlobals();
  });

  it("probes Android local agent health through the native Agent plugin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLocalAgent()).resolves.toBe(true);

    expect(agentRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/api/health",
        headers: expect.objectContaining({
          Accept: "application/json",
          "X-ElizaOS-Client-Id": "local-agent-probe",
        }),
        timeoutMs: 1500,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the running agent state health shape from the native probe", async () => {
    agentRequestMock.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ agentState: "running" }),
    });

    await expect(probeLocalAgent()).resolves.toBe(true);
  });

  it("does not return the Capacitor plugin proxy as a thenable", async () => {
    const thenMock = vi.fn(() => {
      throw new Error("Agent.then should not be called");
    });
    const agentPlugin = {
      request: agentRequestMock,
    };
    const thenKey = ["t", "hen"].join("");
    Object.defineProperty(agentPlugin, thenKey, { value: thenMock });
    capacitorState.plugins.Agent = agentPlugin;

    await expect(probeLocalAgent()).resolves.toBe(true);

    expect(thenMock).not.toHaveBeenCalled();
  });

  it("returns false when the native local agent probe is unauthorized", async () => {
    agentRequestMock.mockResolvedValueOnce({
      status: 401,
      body: JSON.stringify({ error: "unauthorized" }),
    });

    await expect(probeLocalAgent()).resolves.toBe(false);
  });

  it("falls back to fetch outside native Android", async () => {
    capacitorState.isNative = false;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLocalAgent()).resolves.toBe(true);

    expect(agentRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:31337/api/health",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
  });
});
