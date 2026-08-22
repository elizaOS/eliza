/** Verifies controller identity isolation and private-key retention at the native store boundary. */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSetResult,
} from "../../../src/security/platform-secure-store";
import {
  desktopClearRemoteSessionState,
  desktopCreateRemoteCommand,
  desktopGetOrCreateControllerIdentity,
  remoteControllerInternals,
} from "./remote-controller-rpc";

class MemorySecureStore implements PlatformSecureStore {
  readonly backend = "none" as const;
  readonly values = new Map<string, string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(vaultId: string): Promise<SecureStoreGetResult> {
    const value = this.values.get(vaultId);
    return value === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, value };
  }

  async set(
    vaultId: string,
    _kind: unknown,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.values.set(vaultId, value);
    return { ok: true };
  }

  async delete(vaultId: string): Promise<SecureStoreDeleteResult> {
    return { ok: true, deleted: this.values.delete(vaultId) };
  }
}

describe("remote controller identity RPC", () => {
  it("returns only public keys and reuses the owner-bound OS-store identity", async () => {
    const store = new MemorySecureStore();
    const params = {
      ownerId: "owner-1",
      deviceId: "desktop-1",
      displayName: "My Linux computer",
      platform: "linux",
    } as const;
    const first = await desktopGetOrCreateControllerIdentity(params, store);
    const second = await desktopGetOrCreateControllerIdentity(params, store);

    expect(second).toEqual(first);
    expect(first.keyId).toMatch(/^p256:/);
    expect(first.signingPublicKeyJwk).not.toHaveProperty("d");
    expect(first.encryptionPublicKeyJwk).not.toHaveProperty("d");
    const stored = JSON.parse([...store.values.values()][0] ?? "{}") as {
      signingPrivateKeyJwk?: JsonWebKey;
      encryptionPrivateKeyJwk?: JsonWebKey;
    };
    expect(stored.signingPrivateKeyJwk?.d).toBeTruthy();
    expect(stored.encryptionPrivateKeyJwk?.d).toBeTruthy();
  });

  it("persists authority-bound sequences and serializes concurrent allocation", async () => {
    const store = new MemorySecureStore();
    const controller = await desktopGetOrCreateControllerIdentity(
      {
        ownerId: "owner-1",
        displayName: "Linux",
        platform: "linux",
      },
      store,
    );
    const targetPrivate = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).privateKey.export({ format: "jwk" });
    const { d: _private, ...targetPublic } = targetPrivate;
    const input = {
      ownerId: "owner-1",
      grantId: "grant-1",
      grantRevision: 1,
      sessionId: "session-1",
      controllerDeviceId: controller.deviceId,
      controllerKeyId: controller.keyId,
      targetRuntimeId: "runtime-1",
      targetKeyId: "target-key-1",
      targetEncryptionPublicKeyJwk: targetPublic,
      action: "agent.request",
      payload: { path: "/api/health", method: "GET" },
    } as const;

    const [first, second] = await Promise.all([
      desktopCreateRemoteCommand(input, store),
      desktopCreateRemoteCommand(input, store),
    ]);
    expect([first.command.body.sequence, second.command.body.sequence]).toEqual(
      [1, 2],
    );
    const afterRestart = await desktopCreateRemoteCommand(input, store);
    expect(afterRestart.command.body.sequence).toBe(3);

    const revised = await desktopCreateRemoteCommand(
      { ...input, grantRevision: 2 },
      store,
    );
    expect(revised.command.body.sequence).toBe(1);
    await expect(
      desktopClearRemoteSessionState(
        {
          ownerId: "owner-1",
          controllerDeviceId: controller.deviceId,
          sessionId: "session-1",
        },
        store,
      ),
    ).resolves.toEqual({ cleared: true });
  });

  it("creates one native-stable device identity under concurrent first use", async () => {
    const store = new MemorySecureStore();
    const params = {
      ownerId: "owner-1",
      displayName: "Linux",
      platform: "linux",
    } as const;
    const [first, second] = await Promise.all([
      desktopGetOrCreateControllerIdentity(params, store),
      desktopGetOrCreateControllerIdentity(params, store),
    ]);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.keyId).toBe(first.keyId);
  });

  it("uses an opaque, owner-and-device-bound vault id and rejects corrupt records", async () => {
    const store = new MemorySecureStore();
    const vaultId = remoteControllerInternals.controllerVaultId(
      "owner-1",
      "desktop-1",
    );
    expect(vaultId).not.toContain("owner-1");
    expect(vaultId).not.toContain("desktop-1");
    expect(
      remoteControllerInternals.controllerVaultId("owner-2", "desktop-1"),
    ).not.toBe(vaultId);

    store.values.set(vaultId, JSON.stringify({ version: 1, identity: {} }));
    await expect(
      desktopGetOrCreateControllerIdentity(
        {
          ownerId: "owner-1",
          deviceId: "desktop-1",
          displayName: "Linux",
          platform: "linux",
        },
        store,
      ),
    ).rejects.toThrow("corrupt");
  });
});
