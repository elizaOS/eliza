/** Tests fail-closed device identity and runtime credential persistence. */
import { describe, expect, it } from "vitest";
import type {
  PlatformSecureStore,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "./platform-secure-store";
import {
  createRemoteDeviceIdentity,
  deleteRemoteDeviceIdentity,
  loadRemoteDevicePrivateKeys,
  loadRemoteRuntimeAccessToken,
  storeRemoteRuntimeAccessToken,
} from "./remote-device-identity";

class MemoryStore implements PlatformSecureStore {
  readonly backend = "none" as const;
  readonly values = new Map<string, string>();
  available = true;
  failKind: SecureStoreSecretKind | null = null;

  async isAvailable() {
    return this.available;
  }
  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const value = this.values.get(`${vaultId}:${kind}`);
    return value === undefined
      ? { ok: false, reason: "not_found" }
      : { ok: true, value };
  }
  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    if (this.failKind === kind) return { ok: false, reason: "denied" };
    this.values.set(`${vaultId}:${kind}`, value);
    return { ok: true };
  }
  async delete(vaultId: string, kind: SecureStoreSecretKind) {
    this.values.delete(`${vaultId}:${kind}`);
  }
}

describe("remote device identity", () => {
  it("stores private keys only in the secure store and can load/delete them", async () => {
    const store = new MemoryStore();
    const created = await createRemoteDeviceIdentity(store, {
      deviceId: "phone-1",
      displayName: "Phone",
      platform: "ios",
    });
    expect(created.publicIdentity.signingPublicKeyJwk.d).toBeUndefined();
    expect(created.publicIdentity.encryptionPublicKeyJwk.d).toBeUndefined();
    const loaded = await loadRemoteDevicePrivateKeys(store, "phone-1");
    expect(loaded?.signingPrivateKeyJwk.d).toBeTruthy();
    expect(loaded?.encryptionPrivateKeyJwk.d).toBeTruthy();
    await deleteRemoteDeviceIdentity(store, "phone-1");
    await expect(
      loadRemoteDevicePrivateKeys(store, "phone-1"),
    ).resolves.toBeNull();
  });

  it("rolls back the signing key if encryption-key storage fails", async () => {
    const store = new MemoryStore();
    store.failKind = "remote.controller_encryption_key";
    await expect(
      createRemoteDeviceIdentity(store, {
        deviceId: "phone-1",
        displayName: "Phone",
        platform: "ios",
      }),
    ).rejects.toThrow("Could not store controller encryption key");
    expect(store.values.size).toBe(0);
  });

  it("fails closed when secure storage is unavailable", async () => {
    const store = new MemoryStore();
    store.available = false;
    await expect(
      createRemoteDeviceIdentity(store, {
        displayName: "Phone",
        platform: "ios",
      }),
    ).rejects.toThrow("OS secure storage is unavailable");
  });

  it("stores runtime credentials in a runtime-scoped secure slot", async () => {
    const store = new MemoryStore();
    await storeRemoteRuntimeAccessToken(store, "mac-1", "secret-token");
    await expect(loadRemoteRuntimeAccessToken(store, "mac-1")).resolves.toBe(
      "secret-token",
    );
    await expect(
      loadRemoteRuntimeAccessToken(store, "mac-2"),
    ).resolves.toBeNull();
  });
});
