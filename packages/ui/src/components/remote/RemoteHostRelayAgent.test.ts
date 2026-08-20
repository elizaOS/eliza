/** Verifies that VPS relay commands stay inside the native SSH gateway. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  claimCloudRemoteCommand: vi.fn(),
  completeCloudRemoteCommand: vi.fn(),
  requestSshRuntime: vi.fn(),
  startSshRuntime: vi.fn(),
  updateAgentProfile: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: {
    claimCloudRemoteCommand: mocks.claimCloudRemoteCommand,
    completeCloudRemoteCommand: mocks.completeCloudRemoteCommand,
  },
}));

vi.mock("../../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: mocks.bridge,
}));
vi.mock("../../platform/ssh-runtime", () => ({
  requestSshRuntime: mocks.requestSshRuntime,
  startSshRuntime: mocks.startSshRuntime,
}));
vi.mock("../../state", () => ({
  loadAgentProfileRegistry: vi.fn(),
  switchRuntimeNonDestructive: vi.fn(),
  updateAgentProfile: mocks.updateAgentProfile,
}));

import {
  dispatchAgentRequest,
  processClaim,
  type RelayTarget,
} from "./RemoteHostRelayAgent";

const target: RelayTarget = {
  kind: "ssh",
  profile: {
    id: "profile-1",
    label: "Production VPS",
    kind: "remote",
    apiBase: "http://127.0.0.1:41000",
    credentialRef: "credential-1",
    createdAt: "2026-08-20T00:00:00.000Z",
    sshGateway: {
      hostId: "host-vps-1",
      runtimeId: "runtime-1",
      target: "eliza@vps.example.com",
      sshPort: 22,
      remoteApiPort: 2138,
    },
  },
};

describe("RemoteHostRelayAgent SSH dispatch", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.startSshRuntime.mockResolvedValue({
      apiBase: "http://127.0.0.1:42000",
      localPort: 42000,
    });
    mocks.requestSshRuntime.mockResolvedValue({ status: 200, body: "ok" });
  });

  it("restores the tunnel and delegates the allowlisted request to native code", async () => {
    const request = {
      path: "/api/health",
      method: "GET" as const,
      headers: { accept: "application/json" },
      body: null,
      timeoutMs: 5_000,
    };
    await expect(dispatchAgentRequest(target, request)).resolves.toEqual({
      status: 200,
      body: "ok",
    });
    expect(mocks.startSshRuntime).toHaveBeenCalledWith(
      target.profile.sshGateway,
    );
    expect(mocks.updateAgentProfile).toHaveBeenCalledWith("profile-1", {
      apiBase: "http://127.0.0.1:42000",
    });
    expect(mocks.requestSshRuntime).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      credentialRef: "credential-1",
      ...request,
    });
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it("keeps the Mac runtime on the local-agent IPC boundary", async () => {
    mocks.bridge.mockResolvedValue({ status: 200, body: "local" });
    await expect(
      dispatchAgentRequest(
        { kind: "local" },
        {
          path: "/api/health",
          method: "GET",
          headers: {},
          body: null,
          timeoutMs: 5_000,
        },
      ),
    ).resolves.toEqual({ status: 200, body: "local" });
    expect(mocks.requestSshRuntime).not.toHaveBeenCalled();
  });

  it("claims, executes, seals, and completes a phone command for the VPS target", async () => {
    const authority = {
      ownerId: "owner-1",
      sessionId: "session-1",
      targetRuntimeId: "host-vps-1",
      controller: {
        version: 1 as const,
        deviceId: "iphone-1",
        displayName: "Phone",
        platform: "ios",
        keyId: "controller-key-1",
        signingPublicKeyJwk: {},
        encryptionPublicKeyJwk: {},
        createdAt: Date.UTC(2026, 7, 20),
      },
    };
    mocks.claimCloudRemoteCommand.mockResolvedValue({
      commandId: "command-1",
      authority,
      envelope: { ciphertext: "opaque" },
    });
    mocks.bridge.mockImplementation(async ({ rpcMethod }) => {
      if (rpcMethod === "desktopOpenRemoteCommand") {
        return {
          body: {
            version: 1,
            commandId: "command-1",
            targetRuntimeId: "host-vps-1",
            action: "agent.status",
          },
          signature: "verified-by-native-boundary",
        };
      }
      if (rpcMethod === "desktopSealRemoteCommandResult") {
        return { ciphertext: "sealed-result" };
      }
      throw new Error(`unexpected RPC ${rpcMethod}`);
    });
    await expect(
      processClaim(
        "host-vps-1",
        "eliza_host_token",
        {
          ...authority.controller,
          platform: "macos",
          deviceId: "gateway-mac-1",
          displayName: "Gateway Mac",
          keyId: "host-key-1",
        },
        "session-1",
        target,
      ),
    ).resolves.toBe(true);
    expect(mocks.requestSshRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "runtime-1",
        path: "/api/health",
      }),
    );
    expect(mocks.completeCloudRemoteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        commandId: "command-1",
        hostId: "host-vps-1",
        hostToken: "eliza_host_token",
        resultEnvelope: { ciphertext: "sealed-result" },
      }),
    );
  });
});
