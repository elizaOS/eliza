/**
 * Colocated coverage for the platform-secure-store contract: every exported
 * secret kind, unavailability reason, result discriminant, backend, and the
 * PlatformSecureStore / PlatformSecureStoreProtection shapes. The ESM module
 * is type-only (no native bindings), so runtime checks drive those types
 * through a Map-backed implementation of the interface — empty store, missing
 * delete, vault/kind isolation, overwrite, and empty-string preservation.
 * No mocks of the contract module.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  PlatformSecureStore,
  PlatformSecureStoreBackend,
  PlatformSecureStoreProtection,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
  SecureStoreUnavailableReason,
} from "./platform-secure-store.ts";

const SECRET_KINDS = [
  "wallet.evm_private_key",
  "wallet.solana_private_key",
  "session.device_auth",
  "session.steward_token",
  "runtime.active_server",
  "runtime.agent_profiles",
  "runtime.access_token",
  "connector.telegram_personal_session",
  "connector.telegram_personal_auth_state",
  "steward.api_url",
  "steward.tenant_id",
  "steward.agent_id",
  "steward.api_key",
  "steward.agent_token",
] as const satisfies readonly SecureStoreSecretKind[];

const UNAVAILABLE_REASONS = [
  "not_found",
  "denied",
  "unavailable",
  "error",
] as const satisfies readonly SecureStoreUnavailableReason[];

const BACKENDS = [
  "macos_keychain",
  "windows_credential_manager",
  "linux_secret_service",
  "file_encrypted_fallback",
  "none",
] as const satisfies readonly PlatformSecureStoreBackend[];

const PROTECTION_SCOPES = [
  "device",
  "host",
  "unavailable",
] as const satisfies readonly PlatformSecureStoreProtection["scope"][];

const PROTECTION_ACCESS = [
  "app_only",
  "user_session",
  "unavailable",
] as const satisfies readonly PlatformSecureStoreProtection["access"][];

class MemoryPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "none";
  private readonly slots = new Map<string, string>();

  private slotKey(vaultId: string, kind: SecureStoreSecretKind): string {
    return `${vaultId}\0${kind}`;
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const value = this.slots.get(this.slotKey(vaultId, kind));
    if (value === undefined) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: true, value };
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    this.slots.set(this.slotKey(vaultId, kind), value);
    return { ok: true };
  }

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    return {
      ok: true,
      deleted: this.slots.delete(this.slotKey(vaultId, kind)),
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function readSecret(result: SecureStoreGetResult): string | undefined {
  if (result.ok) {
    return result.value;
  }
  return undefined;
}

function setSucceeded(result: SecureStoreSetResult): boolean {
  return result.ok;
}

function deleteRemoved(result: SecureStoreDeleteResult): boolean {
  return result.ok && result.deleted;
}

describe("platform-secure-store module", () => {
  it("is a type-only module with no runtime exports", async () => {
    const mod = await import("./platform-secure-store.ts");
    expect(Object.keys(mod)).toEqual([]);
  });
});

describe("SecureStoreSecretKind", () => {
  it("is the closed fourteen-kind union in declaration order", () => {
    expectTypeOf<SecureStoreSecretKind>().toEqualTypeOf<
      (typeof SECRET_KINDS)[number]
    >();
    expect(SECRET_KINDS).toEqual([
      "wallet.evm_private_key",
      "wallet.solana_private_key",
      "session.device_auth",
      "session.steward_token",
      "runtime.active_server",
      "runtime.agent_profiles",
      "runtime.access_token",
      "connector.telegram_personal_session",
      "connector.telegram_personal_auth_state",
      "steward.api_url",
      "steward.tenant_id",
      "steward.agent_id",
      "steward.api_key",
      "steward.agent_token",
    ]);
    expect(new Set(SECRET_KINDS).size).toBe(SECRET_KINDS.length);
  });
});

describe("SecureStoreUnavailableReason", () => {
  it("is the closed four-reason union in declaration order", () => {
    expectTypeOf<SecureStoreUnavailableReason>().toEqualTypeOf<
      (typeof UNAVAILABLE_REASONS)[number]
    >();
    expect(UNAVAILABLE_REASONS).toEqual([
      "not_found",
      "denied",
      "unavailable",
      "error",
    ]);
  });
});

describe("SecureStoreGetResult", () => {
  it("is a success value or a failed reason, never both", () => {
    expectTypeOf<SecureStoreGetResult>().toEqualTypeOf<
      | { ok: true; value: string }
      | {
          ok: false;
          reason: SecureStoreUnavailableReason;
          message?: string;
        }
    >();

    const hit: SecureStoreGetResult = { ok: true, value: "secret" };
    const miss: SecureStoreGetResult = { ok: false, reason: "not_found" };
    const denied: SecureStoreGetResult = {
      ok: false,
      reason: "denied",
      message: "user declined",
    };

    expect(readSecret(hit)).toBe("secret");
    expect(readSecret(miss)).toBeUndefined();
    expect(readSecret(denied)).toBeUndefined();
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.value).toBe("secret");
    }
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.reason).toBe("not_found");
      expect(miss.message).toBeUndefined();
    }
    if (!denied.ok) {
      expect(denied.reason).toBe("denied");
      expect(denied.message).toBe("user declined");
    }
  });

  it("treats an empty string as a stored value, not an absence", () => {
    const empty: SecureStoreGetResult = { ok: true, value: "" };
    expect(empty.ok).toBe(true);
    expect(readSecret(empty)).toBe("");
  });

  it("accepts every unavailability reason on the failure branch", () => {
    for (const reason of UNAVAILABLE_REASONS) {
      const result: SecureStoreGetResult = { ok: false, reason };
      expect(result.ok).toBe(false);
      expect(readSecret(result)).toBeUndefined();
      if (!result.ok) {
        expect(result.reason).toBe(reason);
      }
    }
  });
});

describe("SecureStoreSetResult", () => {
  it("is a unit success or a failed reason", () => {
    expectTypeOf<SecureStoreSetResult>().toEqualTypeOf<
      | { ok: true }
      | { ok: false; reason: SecureStoreUnavailableReason; message?: string }
    >();

    const ok: SecureStoreSetResult = { ok: true };
    const unavailable: SecureStoreSetResult = {
      ok: false,
      reason: "unavailable",
      message: "Secret Service is down",
    };

    expect(setSucceeded(ok)).toBe(true);
    expect(setSucceeded(unavailable)).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.reason).toBe("unavailable");
      expect(unavailable.message).toBe("Secret Service is down");
    }
  });
});

describe("SecureStoreDeleteResult", () => {
  it("reports whether a successful delete removed an item", () => {
    expectTypeOf<SecureStoreDeleteResult>().toEqualTypeOf<
      | { ok: true; deleted: boolean }
      | { ok: false; reason: SecureStoreUnavailableReason; message?: string }
    >();

    const removed: SecureStoreDeleteResult = { ok: true, deleted: true };
    const missing: SecureStoreDeleteResult = { ok: true, deleted: false };
    const error: SecureStoreDeleteResult = {
      ok: false,
      reason: "error",
      message: "native delete failed",
    };

    expect(deleteRemoved(removed)).toBe(true);
    expect(deleteRemoved(missing)).toBe(false);
    expect(deleteRemoved(error)).toBe(false);
    if (missing.ok) {
      expect(missing.deleted).toBe(false);
    }
    if (!error.ok) {
      expect(error.reason).toBe("error");
    }
  });
});

describe("PlatformSecureStoreBackend", () => {
  it("is the closed five-backend union in declaration order", () => {
    expectTypeOf<PlatformSecureStoreBackend>().toEqualTypeOf<
      (typeof BACKENDS)[number]
    >();
    expect(BACKENDS).toEqual([
      "macos_keychain",
      "windows_credential_manager",
      "linux_secret_service",
      "file_encrypted_fallback",
      "none",
    ]);
  });
});

describe("PlatformSecureStoreProtection", () => {
  it("pins synchronized to the literal false, not a boolean", () => {
    expectTypeOf<
      PlatformSecureStoreProtection["synchronized"]
    >().toEqualTypeOf<false>();
    expectTypeOf<
      PlatformSecureStoreProtection["synchronized"]
    >().not.toEqualTypeOf<boolean>();
    expectTypeOf<PlatformSecureStoreProtection["scope"]>().toEqualTypeOf<
      (typeof PROTECTION_SCOPES)[number]
    >();
    expectTypeOf<PlatformSecureStoreProtection["access"]>().toEqualTypeOf<
      (typeof PROTECTION_ACCESS)[number]
    >();
  });

  it("accepts every backend with available=false and unavailable scope/access", () => {
    for (const backend of BACKENDS) {
      const protection: PlatformSecureStoreProtection = {
        backend,
        available: false,
        synchronized: false,
        scope: "unavailable",
        access: "unavailable",
      };
      expect(protection.synchronized).toBe(false);
      expect(protection.available).toBe(false);
      expect(protection.backend).toBe(backend);
    }
  });

  it("accepts device/app_only and host/user_session scopes", () => {
    const device: PlatformSecureStoreProtection = {
      backend: "macos_keychain",
      available: true,
      synchronized: false,
      scope: "device",
      access: "app_only",
    };
    const host: PlatformSecureStoreProtection = {
      backend: "linux_secret_service",
      available: true,
      synchronized: false,
      scope: "host",
      access: "user_session",
    };
    expect(device.scope).toBe("device");
    expect(device.access).toBe("app_only");
    expect(host.scope).toBe("host");
    expect(host.access).toBe("user_session");
  });
});

describe("PlatformSecureStore", () => {
  it("requires backend plus get/set/delete/isAvailable", () => {
    expectTypeOf<
      PlatformSecureStore["backend"]
    >().toEqualTypeOf<PlatformSecureStoreBackend>();
    expectTypeOf<PlatformSecureStore["get"]>().parameters.toEqualTypeOf<
      [vaultId: string, kind: SecureStoreSecretKind]
    >();
    expectTypeOf<PlatformSecureStore["get"]>().returns.toEqualTypeOf<
      Promise<SecureStoreGetResult>
    >();
    expectTypeOf<PlatformSecureStore["set"]>().parameters.toEqualTypeOf<
      [vaultId: string, kind: SecureStoreSecretKind, value: string]
    >();
    expectTypeOf<PlatformSecureStore["set"]>().returns.toEqualTypeOf<
      Promise<SecureStoreSetResult>
    >();
    expectTypeOf<PlatformSecureStore["delete"]>().parameters.toEqualTypeOf<
      [vaultId: string, kind: SecureStoreSecretKind]
    >();
    expectTypeOf<PlatformSecureStore["delete"]>().returns.toEqualTypeOf<
      Promise<SecureStoreDeleteResult>
    >();
    expectTypeOf<PlatformSecureStore["isAvailable"]>().returns.toEqualTypeOf<
      Promise<boolean>
    >();
  });

  it("returns not_found from an empty store", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    expect(store.backend).toBe("none");
    await expect(store.isAvailable()).resolves.toBe(true);
    await expect(
      store.get("vault-a", "session.steward_token"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("round-trips a single secret and overwrites in place", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    await expect(
      store.set("vault-a", "session.steward_token", "first"),
    ).resolves.toEqual({ ok: true });
    await expect(
      store.get("vault-a", "session.steward_token"),
    ).resolves.toEqual({ ok: true, value: "first" });
    await expect(
      store.set("vault-a", "session.steward_token", "second"),
    ).resolves.toEqual({ ok: true });
    await expect(
      store.get("vault-a", "session.steward_token"),
    ).resolves.toEqual({ ok: true, value: "second" });
  });

  it("isolates secrets by vault id and by kind", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    await store.set("vault-a", "wallet.evm_private_key", "a-evm");
    await store.set("vault-b", "wallet.evm_private_key", "b-evm");
    await store.set("vault-a", "wallet.solana_private_key", "a-sol");

    await expect(
      store.get("vault-a", "wallet.evm_private_key"),
    ).resolves.toEqual({ ok: true, value: "a-evm" });
    await expect(
      store.get("vault-b", "wallet.evm_private_key"),
    ).resolves.toEqual({ ok: true, value: "b-evm" });
    await expect(
      store.get("vault-a", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: true, value: "a-sol" });
    await expect(
      store.get("vault-b", "wallet.solana_private_key"),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("preserves empty, whitespace, and unicode credential bytes", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    const payload = ' \n\t"quoted" \\ 你好';
    await store.set("vault-a", "runtime.access_token", payload);
    await store.set("vault-a", "session.device_auth", "");
    await expect(store.get("vault-a", "runtime.access_token")).resolves.toEqual(
      { ok: true, value: payload },
    );
    await expect(store.get("vault-a", "session.device_auth")).resolves.toEqual({
      ok: true,
      value: "",
    });
  });

  it("delete of a missing item succeeds with deleted:false", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    await expect(store.delete("vault-a", "steward.api_key")).resolves.toEqual({
      ok: true,
      deleted: false,
    });
  });

  it("delete of a present item succeeds with deleted:true then is absent", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    await store.set("vault-a", "steward.api_key", "k");
    await expect(store.delete("vault-a", "steward.api_key")).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    await expect(store.get("vault-a", "steward.api_key")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    await expect(store.delete("vault-a", "steward.api_key")).resolves.toEqual({
      ok: true,
      deleted: false,
    });
  });

  it("round-trips every secret kind independently in one vault", async () => {
    const store: PlatformSecureStore = new MemoryPlatformSecureStore();
    for (const kind of SECRET_KINDS) {
      await expect(
        store.set("vault-a", kind, `value:${kind}`),
      ).resolves.toEqual({ ok: true });
    }
    for (const kind of SECRET_KINDS) {
      await expect(store.get("vault-a", kind)).resolves.toEqual({
        ok: true,
        value: `value:${kind}`,
      });
    }
    const removed = SECRET_KINDS[0];
    await expect(store.delete("vault-a", removed)).resolves.toEqual({
      ok: true,
      deleted: true,
    });
    await expect(store.get("vault-a", removed)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    for (const kind of SECRET_KINDS.slice(1)) {
      await expect(store.get("vault-a", kind)).resolves.toEqual({
        ok: true,
        value: `value:${kind}`,
      });
    }
  });
});
