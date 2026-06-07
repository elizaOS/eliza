// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  __resetIosLocalAgentTransportForTests,
  handleIosLocalAgentNativeRequest,
  installIosLocalAgentFetchBridge,
  isIosInProcessLocalAgentBase,
} from "./ios-local-agent-transport";
import "./client-agent";

const { capacitorState } = vi.hoisted(() => ({
  capacitorState: {
    isNative: true,
    platform: "ios",
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorState.platform,
    isNativePlatform: () => capacitorState.isNative,
    isPluginAvailable: () => false,
  },
}));

vi.mock("../build-variant", () => ({
  isStoreBuild: () => true,
}));

describe("iOS local-agent transport", () => {
  const previousMode = process.env.MODE;

  beforeEach(() => {
    process.env.MODE = "development";
    capacitorState.isNative = true;
    capacitorState.platform = "ios";
    localStorage.clear();
    localStorage.setItem("eliza:mobile-runtime-mode", "cloud");
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "cloud:agent-1",
        kind: "cloud",
        label: "Cloud Agent",
        apiBase: "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1/bridge",
        accessToken: "cloud-token",
      }),
    );
  });

  afterEach(() => {
    __resetIosLocalAgentTransportForTests();
    process.env.MODE = previousMode;
    localStorage.clear();
  });

  it("allows Cloud-mode app shell IPC routes without switching to local runtime", async () => {
    expect(isIosInProcessLocalAgentBase("eliza-local-agent://ipc")).toBe(true);

    const response = await handleIosLocalAgentNativeRequest({
      method: "GET",
      path: "/api/auth/status",
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      cloudProvisioned: true,
      cloudAgentId: "agent-1",
      cloudConnectionStatus: "connected",
    });
  });

  it("lets ElizaClient poll iOS Cloud shell status through IPC", async () => {
    installIosLocalAgentFetchBridge();
    const client = new ElizaClient("eliza-local-agent://ipc", "cloud-token");

    await expect(client.getAuthStatus()).resolves.toMatchObject({
      cloudProvisioned: true,
      cloudAgentId: "agent-1",
      cloudConnectionStatus: "connected",
    });
    await expect(client.getFirstRunStatus()).resolves.toMatchObject({
      complete: true,
      cloudProvisioned: true,
      deploymentTarget: "cloud",
    });
  });

  it("exposes Cloud shell auth and runtime identity in store builds", async () => {
    installIosLocalAgentFetchBridge();

    const authResponse = await fetch("eliza-local-agent://ipc/api/auth/me");
    const modeResponse = await fetch(
      "eliza-local-agent://ipc/api/runtime/mode",
    );

    expect(authResponse.status).toBe(200);
    await expect(authResponse.json()).resolves.toMatchObject({
      identity: {
        id: "agent-1",
        displayName: "Cloud Agent",
        kind: "machine",
      },
      session: { id: "cloud:agent-1", kind: "machine" },
      access: { mode: "bearer" },
    });
    expect(modeResponse.status).toBe(200);
    await expect(modeResponse.json()).resolves.toMatchObject({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: true,
    });
  });

  it("keeps local runtime routes blocked in iOS Cloud store builds", async () => {
    await expect(
      handleIosLocalAgentNativeRequest({
        method: "GET",
        path: "/api/local-inference/hub",
      }),
    ).rejects.toThrow(
      "iOS cloud builds cannot use local-agent IPC unless local runtime mode is active",
    );
  });
});
