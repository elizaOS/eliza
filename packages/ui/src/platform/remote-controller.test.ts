/** Exercises the Capacitor controller adapter with a deterministic native bridge double. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getOrCreateIdentity: vi.fn(),
  createCommand: vi.fn(),
  acknowledgeEnqueue: vi.fn(),
  openResult: vi.fn(),
  openStartReceipt: vi.fn(),
  clearSessionState: vi.fn(),
}));
const nativeAvailable = vi.hoisted(() => ({ value: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
    isPluginAvailable: () => nativeAvailable.value,
    registerPlugin: () => native,
  },
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
}));

import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import {
  acknowledgeRemoteCommandEnqueue,
  clearRemoteControllerSessionState,
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
  openRemoteCommandResult,
  openRemoteCommandStartReceipt,
} from "./remote-controller";

describe("Capacitor remote controller bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeAvailable.value = true;
  });

  it("uses native identity storage and never accepts a private key", async () => {
    native.getOrCreateIdentity.mockResolvedValue({
      version: 1,
      role: "controller",
      ownerId: "owner-1",
      deviceId: "iphone-1",
      keyId: "key-1",
      displayName: "My iPhone",
      platform: "ios",
      signingPublicKeyJwk: {
        kty: "EC",
        x: "A".repeat(43),
        y: "B".repeat(43),
        crv: "P-256",
      },
      encryptionPublicKeyJwk: {
        kty: "EC",
        x: "C".repeat(43),
        y: "D".repeat(43),
        crv: "P-256",
      },
      createdAt: 1,
    });
    const identity = await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-1",
    });
    expect(identity.deviceId).toBe("iphone-1");
    expect(native.getOrCreateIdentity).toHaveBeenCalledWith(
      expect.not.objectContaining({
        privateKey: expect.anything(),
        privateKeyJwk: expect.anything(),
      }),
    );
  });

  it("rejects private material or a mismatched native identity", async () => {
    const identity = {
      version: 1,
      role: "controller",
      ownerId: "owner-1",
      deviceId: "iphone-1",
      keyId: "key-1",
      displayName: "My iPhone",
      platform: "ios",
      signingPublicKeyJwk: {
        kty: "EC",
        x: "A".repeat(43),
        y: "B".repeat(43),
        crv: "P-256",
      },
      encryptionPublicKeyJwk: {
        kty: "EC",
        x: "C".repeat(43),
        y: "D".repeat(43),
        crv: "P-256",
      },
      createdAt: 1,
    };
    native.getOrCreateIdentity.mockResolvedValue({
      ...identity,
      signingPublicKeyJwk: { ...identity.signingPublicKeyJwk, d: "secret" },
      privateKeyJwk: { d: "secret" },
    });
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("pairing identity is unavailable");

    native.getOrCreateIdentity.mockResolvedValue({
      ...identity,
      ownerId: "other-owner",
      platform: "android",
    });
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("pairing identity is unavailable");
  });

  it("fails closed when native signing is unavailable", async () => {
    native.createCommand.mockResolvedValue(null);
    await expect(
      createRemoteCommand({
        ownerId: "owner-1",
        grantId: "grant-1",
        grantRevision: 1,
        sessionId: "session-1",
        controller: { deviceId: "iphone-1", keyId: "key-1" } as never,
        target: {
          runtimeId: "mac-1",
          keyId: "target-key",
          encryptionPublicKeyJwk: {},
        } as never,
        action: "observe" as never,
        payload: {},
      }),
    ).rejects.toThrow("Secure mobile command signing is unavailable");
  });

  it("fails closed when the native iOS plugin is absent", async () => {
    nativeAvailable.value = false;
    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-1" }),
    ).rejects.toThrow("native iOS plugin is installed");
    nativeAvailable.value = true;
  });

  it("never falls through to desktop RPC for absent native operations", async () => {
    nativeAvailable.value = false;
    const calls = [
      createRemoteCommand({} as never),
      acknowledgeRemoteCommandEnqueue({} as never),
      openRemoteCommandResult({} as never),
      openRemoteCommandStartReceipt({} as never),
      clearRemoteControllerSessionState({} as never),
    ];
    const results = await Promise.allSettled(calls);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(
      results.map((result) =>
        result.status === "rejected" && result.reason instanceof Error
          ? result.reason.message
          : null,
      ),
    ).toEqual([
      "Secure mobile command signing is unavailable until the native iOS plugin is installed.",
      "Secure mobile enqueue acknowledgement is unavailable until the native iOS plugin is installed.",
      "Secure mobile result decryption is unavailable until the native iOS plugin is installed.",
      "Secure mobile start receipt verification is unavailable until the native iOS plugin is installed.",
      "Secure mobile session cleanup is unavailable until the native iOS plugin is installed.",
    ]);
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalled();
    expect(native.createCommand).not.toHaveBeenCalled();
    expect(native.acknowledgeEnqueue).not.toHaveBeenCalled();
    expect(native.openResult).not.toHaveBeenCalled();
    expect(native.openStartReceipt).not.toHaveBeenCalled();
    expect(native.clearSessionState).not.toHaveBeenCalled();
  });

  it("rejects malformed acknowledgement and cleanup bridge responses", async () => {
    native.acknowledgeEnqueue.mockResolvedValue({ acknowledged: "yes" });
    await expect(
      acknowledgeRemoteCommandEnqueue({
        ownerId: "owner-1",
        controllerDeviceId: "iphone-1",
        sessionId: "session-1",
        commandId: "command-1",
        bindingDigest: "A".repeat(43),
      }),
    ).rejects.toThrow("acknowledgement is unavailable");

    native.clearSessionState.mockResolvedValue(null);
    await expect(
      clearRemoteControllerSessionState({
        ownerId: "owner-1",
        controllerDeviceId: "iphone-1",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("session cleanup is unavailable");
  });

  it("accepts only terminal result statuses and complete start receipts", async () => {
    const authority = {
      ownerId: "owner-1",
      controllerDeviceId: "iphone-1",
      envelope: {},
      command: {},
      targetIdentity: {},
    } as never;
    native.openResult.mockResolvedValue({ status: "started" });
    await expect(openRemoteCommandResult(authority)).rejects.toThrow(
      "result decryption is unavailable",
    );

    native.openStartReceipt.mockResolvedValue({ startedAt: 1 });
    await expect(openRemoteCommandStartReceipt(authority)).rejects.toThrow(
      "start receipt verification is unavailable",
    );
  });
});
