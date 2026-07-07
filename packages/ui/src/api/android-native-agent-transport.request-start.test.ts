/**
 * Guard/dispatch behavior of requestAndroidLocalAgentStartForUrl — the
 * startup coordinator's "ask native to start the agent you are polling" seam
 * (#15189). Drives the REAL transport module against the real Capacitor
 * runtime object with its platform/plugin surface patched per case; no module
 * mocks.
 */
import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANDROID_LOCAL_AGENT_IPC_BASE } from "../first-run/mobile-runtime-mode";
import { requestAndroidLocalAgentStartForUrl } from "./android-native-agent-transport";

type MutableCapacitor = typeof Capacitor & {
  getPlatform: () => string;
  Plugins?: Record<string, unknown>;
};

const cap = Capacitor as MutableCapacitor;
const originalGetPlatform = cap.getPlatform;
const originalPlugins = cap.Plugins;

let startCalls: number;

function installAgentPlugin(plugin: Record<string, unknown>): void {
  cap.Plugins = { Agent: plugin };
}

beforeEach(() => {
  startCalls = 0;
  cap.getPlatform = () => "android";
  installAgentPlugin({
    start: async () => {
      startCalls += 1;
      return { status: "starting" };
    },
  });
});

afterEach(() => {
  cap.getPlatform = originalGetPlatform;
  cap.Plugins = originalPlugins;
});

describe("requestAndroidLocalAgentStartForUrl", () => {
  it("asks the native Agent plugin to start for the local-IPC base", async () => {
    const requested = await requestAndroidLocalAgentStartForUrl(
      `${ANDROID_LOCAL_AGENT_IPC_BASE}/api/auth/status`,
    );
    expect(requested).toBe(true);
    expect(startCalls).toBe(1);
  });

  it("does not fire for a non-local base", async () => {
    const requested = await requestAndroidLocalAgentStartForUrl(
      "https://api.elizacloud.ai/api/auth/status",
    );
    expect(requested).toBe(false);
    expect(startCalls).toBe(0);
  });

  it("does not fire off native Android", async () => {
    cap.getPlatform = () => "web";
    const requested = await requestAndroidLocalAgentStartForUrl(
      `${ANDROID_LOCAL_AGENT_IPC_BASE}/api/auth/status`,
    );
    expect(requested).toBe(false);
    expect(startCalls).toBe(0);
  });

  it("degrades to false when the plugin lacks start", async () => {
    installAgentPlugin({
      getStatus: async () => ({ status: "unknown" }),
    });
    const requested = await requestAndroidLocalAgentStartForUrl(
      `${ANDROID_LOCAL_AGENT_IPC_BASE}/api/auth/status`,
    );
    expect(requested).toBe(false);
  });

  it("degrades to false when the native start rejects", async () => {
    installAgentPlugin({
      start: async () => {
        startCalls += 1;
        throw new Error("Failed to start local agent service");
      },
    });
    const requested = await requestAndroidLocalAgentStartForUrl(
      `${ANDROID_LOCAL_AGENT_IPC_BASE}/api/auth/status`,
    );
    expect(requested).toBe(false);
    expect(startCalls).toBe(1);
  });

  it("handles null and undefined bases", async () => {
    expect(await requestAndroidLocalAgentStartForUrl(null)).toBe(false);
    expect(await requestAndroidLocalAgentStartForUrl(undefined)).toBe(false);
    expect(startCalls).toBe(0);
  });
});
