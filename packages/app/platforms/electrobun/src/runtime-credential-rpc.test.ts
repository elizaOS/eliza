/** Exercises the native runtime credential boundary with a deterministic in-memory secure store. */
import { describe, expect, it } from "vitest";

import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSetResult,
} from "../../../src/security/platform-secure-store";
import {
  deleteRuntimeCredentialRecord,
  desktopDeleteRuntimeCredential,
  desktopLoadRuntimeCredential,
  desktopStoreRuntimeCredential,
  readRuntimeCredentialSnapshot,
  runtimeCredentialInternals,
  storeSshHostFingerprint,
} from "./runtime-credential-rpc";

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

describe("runtime credential RPC", () => {
  it("stores access tokens and SSH trust together without exposing the store key", async () => {
    const store = new MemorySecureStore();
    await desktopStoreRuntimeCredential(
      { runtimeId: "vps-prod", accessToken: " secret-token " },
      store,
    );
    await storeSshHostFingerprint(
      "vps-prod",
      `SHA256:${"A".repeat(43)}`,
      store,
    );

    await expect(
      readRuntimeCredentialSnapshot("vps-prod", store),
    ).resolves.toEqual({
      accessToken: "secret-token",
      sshHostFingerprint: `SHA256:${"A".repeat(43)}`,
    });
    expect([...store.values.keys()]).toEqual([
      runtimeCredentialInternals.credentialVaultId("vps-prod"),
    ]);
    expect([...store.values.keys()][0]).not.toContain("vps-prod");
  });

  it("deletes only the token while retaining the trusted host key", async () => {
    const store = new MemorySecureStore();
    await desktopStoreRuntimeCredential(
      { runtimeId: "vps-prod", accessToken: "token" },
      store,
    );
    await storeSshHostFingerprint(
      "vps-prod",
      `SHA256:${"B".repeat(43)}`,
      store,
    );

    await expect(
      desktopDeleteRuntimeCredential({ runtimeId: "vps-prod" }, store),
    ).resolves.toEqual({ deleted: true });
    await expect(
      desktopLoadRuntimeCredential({ runtimeId: "vps-prod" }, store),
    ).resolves.toEqual({ accessToken: null });
    await expect(
      readRuntimeCredentialSnapshot("vps-prod", store),
    ).resolves.toMatchObject({
      sshHostFingerprint: `SHA256:${"B".repeat(43)}`,
    });
  });

  it("rejects malformed ids, fingerprints, oversized tokens, and corrupt records", async () => {
    const store = new MemorySecureStore();
    await expect(
      desktopStoreRuntimeCredential(
        { runtimeId: "../../escape", accessToken: "token" },
        store,
      ),
    ).rejects.toThrow("Runtime id is invalid");
    await expect(
      storeSshHostFingerprint("runtime", "md5:unsafe", store),
    ).rejects.toThrow("fingerprint is invalid");
    await expect(
      desktopStoreRuntimeCredential(
        { runtimeId: "runtime", accessToken: "x".repeat(65_537) },
        store,
      ),
    ).rejects.toThrow("too large");

    store.values.set(
      runtimeCredentialInternals.credentialVaultId("runtime"),
      "not-json",
    );
    await expect(
      readRuntimeCredentialSnapshot("runtime", store),
    ).rejects.toThrow("corrupt");
  });

  it("removes the complete record on explicit runtime removal", async () => {
    const store = new MemorySecureStore();
    await desktopStoreRuntimeCredential(
      { runtimeId: "runtime", accessToken: "token" },
      store,
    );
    await deleteRuntimeCredentialRecord("runtime", store);
    await expect(
      readRuntimeCredentialSnapshot("runtime", store),
    ).resolves.toEqual({ accessToken: null, sshHostFingerprint: null });
  });
});
