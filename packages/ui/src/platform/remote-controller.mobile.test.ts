/** Covers device-only native controller identity creation and persistence. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRemoteControllerKeyId } from "@elizaos/shared/contracts/remote-control";

const native = vi.hoisted(() => ({
  platform: "ios",
  value: undefined as string | undefined,
  get: vi.fn(),
  set: vi.fn(),
  desktop: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => native.platform },
}));
vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: native.get,
    set: native.set,
  },
}));
vi.mock("../bridge/electrobun-rpc", () => ({
  invokeDesktopBridgeRequest: native.desktop,
}));

import {
  clearRemoteControllerSessionState,
  getOrCreateRemoteControllerIdentity,
} from "./remote-controller";

describe("native remote controller identity", () => {
  beforeEach(() => {
    native.platform = "ios";
    native.value = undefined;
    native.get.mockReset().mockImplementation(async () =>
      native.value
        ? { ok: true, value: native.value }
        : { ok: false, error: "not_found" },
    );
    native.set.mockReset().mockImplementation(async ({ value }) => {
      native.value = value;
      return { ok: true };
    });
    native.desktop.mockReset();
  });

  it("persists one exact account-bound iPhone identity", async () => {
    const first = await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-one",
      displayName: "Nubs's iPhone",
    });
    const second = await getOrCreateRemoteControllerIdentity({
      ownerId: "owner-one",
      displayName: "Changed label",
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      ownerId: "owner-one",
      displayName: "Nubs's iPhone",
      platform: "ios",
    });
    expect(first.keyId).toBe(
      await deriveRemoteControllerKeyId(
        first.signingPublicKeyJwk,
        first.encryptionPublicKeyJwk,
      ),
    );
    expect(native.set).toHaveBeenCalledOnce();
    expect(native.desktop).not.toHaveBeenCalled();
    expect(JSON.parse(native.value ?? "{}")).toMatchObject({
      version: 1,
      identity: first,
      signingPrivateKeyJwk: { d: expect.any(String) },
      encryptionPrivateKeyJwk: { d: expect.any(String) },
    });
  });

  it("fails closed when persisted key material no longer matches the identity", async () => {
    await getOrCreateRemoteControllerIdentity({ ownerId: "owner-one" });
    const stored = JSON.parse(native.value ?? "{}") as {
      identity: { keyId: string };
    };
    stored.identity.keyId = `p256:${"A".repeat(43)}`;
    native.value = JSON.stringify(stored);

    await expect(
      getOrCreateRemoteControllerIdentity({ ownerId: "owner-one" }),
    ).rejects.toThrow("Stored controller identity is corrupt");
  });

  it("acknowledges phone revocation cleanup without invoking a desktop bridge", async () => {
    await expect(
      clearRemoteControllerSessionState({
        ownerId: "owner-one",
        controllerDeviceId: "iphone-one",
        sessionId: "session-one",
      }),
    ).resolves.toBe(true);
    expect(native.desktop).not.toHaveBeenCalled();
  });
});
