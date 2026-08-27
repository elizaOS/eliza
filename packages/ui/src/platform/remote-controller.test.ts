import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getOrCreateIdentity: vi.fn(),
  createCommand: vi.fn(),
  acknowledgeEnqueue: vi.fn(),
  openResult: vi.fn(),
  openStartReceipt: vi.fn(),
  clearSessionState: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
    registerPlugin: () => native,
  },
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: vi.fn(),
}));

import {
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
} from "./remote-controller";

describe("Capacitor remote controller bridge", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses native identity storage and never accepts a private key", async () => {
    native.getOrCreateIdentity.mockResolvedValue({
      deviceId: "iphone-1",
      keyId: "key-1",
      encryptionPublicKeyJwk: { kty: "EC", x: "x", y: "y", crv: "P-256" },
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
});
