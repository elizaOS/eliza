/**
 * Tests master-key resolver behavior without touching the host keychain.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generateMasterKey, KEY_BYTES } from "../src/crypto.js";
import {
  attestationMasterKey,
  defaultMasterKey,
  inMemoryMasterKey,
  MasterKeyUnavailableError,
  passphraseMasterKey,
  passphraseMasterKeyFromEnv,
  type TeeAttestationVerifier,
} from "../src/master-key.js";
import { runtimePassphraseMasterKeyCaller } from "./vitest-assertion-shim.js";

describe("passphraseMasterKey", () => {
  test("returns a 32-byte key for a valid passphrase", async () => {
    const r = passphraseMasterKey({
      passphrase: "this-is-a-test-passphrase",
      cost: 1024, // low cost for test speed
    });
    const key = await r.load();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(KEY_BYTES);
  });

  test("same passphrase + salt + cost produces deterministic output", async () => {
    const a = passphraseMasterKey({
      passphrase: "test-passphrase-stable",
      salt: "fixed-salt",
      cost: 1024,
    });
    const b = passphraseMasterKey({
      passphrase: "test-passphrase-stable",
      salt: "fixed-salt",
      cost: 1024,
    });
    const k1 = await a.load();
    const k2 = await b.load();
    expect(k1.equals(k2)).toBe(true);
  });

  test("different passphrases produce different keys", async () => {
    const a = passphraseMasterKey({
      passphrase: "passphrase-one-aaaa",
      cost: 1024,
    });
    const b = passphraseMasterKey({
      passphrase: "passphrase-two-bbbb",
      cost: 1024,
    });
    const k1 = await a.load();
    const k2 = await b.load();
    expect(k1.equals(k2)).toBe(false);
  });

  test("different salts produce different keys for the same passphrase", async () => {
    const passphrase = "shared-test-passphrase";
    const a = passphraseMasterKey({ passphrase, salt: "salt-a", cost: 1024 });
    const b = passphraseMasterKey({ passphrase, salt: "salt-b", cost: 1024 });
    const k1 = await a.load();
    const k2 = await b.load();
    expect(k1.equals(k2)).toBe(false);
  });

  test("different services produce different default salts", async () => {
    const passphrase = "shared-test-passphrase";
    const a = passphraseMasterKey({
      passphrase,
      service: "service-a",
      cost: 1024,
    });
    const b = passphraseMasterKey({
      passphrase,
      service: "service-b",
      cost: 1024,
    });
    const k1 = await a.load();
    const k2 = await b.load();
    expect(k1.equals(k2)).toBe(false);
  });

  test("rejects passphrases shorter than 12 characters", () => {
    expect(() =>
      passphraseMasterKey({ passphrase: "tooshort", cost: 1024 }),
    ).toThrow(MasterKeyUnavailableError);
  });

  test("rejects non-string passphrase", () => {
    expect(() =>
      runtimePassphraseMasterKeyCaller(passphraseMasterKey)({
        passphrase: undefined,
        cost: 1024,
      }),
    ).toThrow(MasterKeyUnavailableError);
  });

  test("describe identifies the service for audit trails", () => {
    const r = passphraseMasterKey({
      passphrase: "fine-passphrase",
      service: "test-service",
      cost: 1024,
    });
    expect(r.describe()).toBe("passphrase://test-service");
  });
});

describe("passphraseMasterKeyFromEnv", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ELIZA_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ELIZA_VAULT_PASSPHRASE;
    else process.env.ELIZA_VAULT_PASSPHRASE = prev;
  });

  test("returns null when env is unset", () => {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
    expect(passphraseMasterKeyFromEnv()).toBeNull();
  });

  test("returns null when env is an empty string", () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "";
    expect(passphraseMasterKeyFromEnv()).toBeNull();
  });

  test("returns a working resolver when env is set", async () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "fine-passphrase-from-env";
    const r = passphraseMasterKeyFromEnv();
    expect(r).not.toBeNull();
    if (!r) return;
    const k = await r.load();
    expect(k.length).toBe(KEY_BYTES);
  });

  test("rejects an env passphrase below the minimum length on load", async () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "tooshort";
    // Construction throws because the passphrase fails validation up-front.
    expect(() => passphraseMasterKeyFromEnv()).toThrow(
      MasterKeyUnavailableError,
    );
  });
});

describe("defaultMasterKey — fallback chain", () => {
  let prev: string | undefined;
  let prevDisable: string | undefined;
  beforeEach(() => {
    prev = process.env.ELIZA_VAULT_PASSPHRASE;
    prevDisable = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    // Force the keychain "safe" path so the existing tests below
    // exercise the keychain attempt regardless of host environment
    // (e.g. headless Linux CI without D-Bus).
    delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ELIZA_VAULT_PASSPHRASE;
    else process.env.ELIZA_VAULT_PASSPHRASE = prev;
    if (prevDisable === undefined)
      delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    else process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = prevDisable;
  });

  test.skipIf(process.platform === "linux")(
    "falls back to passphrase when keychain unavailable AND env is set",
    async () => {
      process.env.ELIZA_VAULT_PASSPHRASE = "fine-fallback-passphrase";
      // Force a guaranteed-bad keychain entry: an empty service yields a
      // construction error from @napi-rs/keyring on macOS Keychain.
      // Skipped on Linux where the same input may go through the
      // headless-unsafe bypass instead — covered explicitly below.
      const r = defaultMasterKey({ service: "" });
      const k = await r.load();
      expect(k.length).toBe(KEY_BYTES);
    },
  );

  test("error message names passphrase remediation when both paths are unavailable", async () => {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
    // Force the keychain bypass path instead of depending on platform-specific
    // invalid service-name behavior. macOS `/usr/bin/security` accepts inputs
    // that @napi-rs/keyring used to reject, so the old sentinel was brittle.
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
    const r = defaultMasterKey({ service: "test" });
    await expect(r.load()).rejects.toThrow(MasterKeyUnavailableError);
    try {
      await r.load();
      throw new Error("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/ELIZA_VAULT_PASSPHRASE/);
    }
  });

  test("describe surfaces both paths when passphrase env is set", () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "fine-test-passphrase-env";
    const r = defaultMasterKey({ service: "test" });
    expect(r.describe()).toContain("keychain://");
    expect(r.describe()).toContain("passphrase://");
  });

  test("describe shows only keychain when passphrase env is unset", () => {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
    const r = defaultMasterKey({ service: "test" });
    expect(r.describe()).toContain("keychain://");
    expect(r.describe()).not.toContain("passphrase://");
  });
});

describe("defaultMasterKey — keychain bypassed on unsafe hosts", () => {
  let prevPassphrase: string | undefined;
  let prevDisable: string | undefined;
  beforeEach(() => {
    prevPassphrase = process.env.ELIZA_VAULT_PASSPHRASE;
    prevDisable = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    // Force the keychain unsafe path on every platform so tests don't
    // depend on host D-Bus state.
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
  });
  afterEach(() => {
    if (prevPassphrase === undefined) delete process.env.ELIZA_VAULT_PASSPHRASE;
    else process.env.ELIZA_VAULT_PASSPHRASE = prevPassphrase;
    if (prevDisable === undefined)
      delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    else process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = prevDisable;
  });

  test("returns passphrase-derived key when env is set", async () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "fine-bypass-passphrase";
    const r = defaultMasterKey({ service: "test" });
    const k = await r.load();
    expect(k.length).toBe(KEY_BYTES);
  });

  test("throws keychain-unsafe error when no passphrase is configured", async () => {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
    const r = defaultMasterKey({ service: "test" });
    await expect(r.load()).rejects.toThrow(/keychain is unsafe/i);
  });

  test("describe reports passphrase path when bypassed and env is set", () => {
    process.env.ELIZA_VAULT_PASSPHRASE = "fine-bypass-passphrase";
    const r = defaultMasterKey({ service: "test" });
    const desc = r.describe();
    expect(desc).toContain("passphrase://test");
    expect(desc).toContain("keychain bypassed");
    expect(desc).not.toMatch(/^keychain:\/\//);
  });

  test("describe reports unavailable when bypassed and no passphrase", () => {
    delete process.env.ELIZA_VAULT_PASSPHRASE;
    const r = defaultMasterKey({ service: "test" });
    const desc = r.describe();
    expect(desc).toContain("unavailable");
    expect(desc).toContain("keychain bypassed");
  });
});

describe("osKeychainMasterKey — public API guard", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
    else process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = prev;
  });

  test("refuses to invoke the native binding on unsafe hosts", async () => {
    // Direct callers of osKeychainMasterKey (plugins, integrations) get
    // the same protection as defaultMasterKey — no native segfault on
    // headless hosts.
    const { osKeychainMasterKey } = await import("../src/master-key.js");
    const r = osKeychainMasterKey({
      service: "test-osk-guard",
      account: "test",
    });
    await expect(r.load()).rejects.toThrow(MasterKeyUnavailableError);
    await expect(r.load()).rejects.toThrow(/keychain is unsafe/i);
  });
});

describe("inMemoryMasterKey — sanity (regression baseline)", () => {
  test("rejects wrong-size buffer", () => {
    expect(() => inMemoryMasterKey(Buffer.alloc(16))).toThrow(
      MasterKeyUnavailableError,
    );
  });

  test("returns the supplied key", async () => {
    const k = Buffer.alloc(KEY_BYTES, 7);
    const r = inMemoryMasterKey(k);
    expect((await r.load()).equals(k)).toBe(true);
  });
});

describe("attestationMasterKey — fail-closed sealed-volume binding", () => {
  /** Trusted: attestation passes → verifier releases the sealed-volume key. */
  function trustedVerifier(key: Buffer): TeeAttestationVerifier {
    return {
      async releaseSealedVolumeKey() {
        return key;
      },
      describe() {
        return "tdx-dstack";
      },
    };
  }

  /** Untrusted: attestation absent/tampered → verifier refuses (throws). */
  function refusingVerifier(reason: string): TeeAttestationVerifier {
    return {
      async releaseSealedVolumeKey() {
        throw new Error(reason);
      },
      describe() {
        return "tdx-dstack";
      },
    };
  }

  test("trusted evidence → releases the sealed-volume master key", async () => {
    const sealedKey = generateMasterKey();
    const r = attestationMasterKey(trustedVerifier(sealedKey));
    const loaded = await r.load();
    expect(loaded.equals(sealedKey)).toBe(true);
  });

  test("absent attestation → key unavailable (throws, no fallback)", async () => {
    const r = attestationMasterKey(
      refusingVerifier("no TEE evidence collected at boot"),
    );
    await expect(r.load()).rejects.toBeInstanceOf(MasterKeyUnavailableError);
    await expect(r.load()).rejects.toThrow(/no TEE evidence/);
  });

  test("tampered attestation → key unavailable (throws, no fallback)", async () => {
    const r = attestationMasterKey(
      refusingVerifier("state-volume key release denied: measurement-mismatch"),
    );
    // Fail closed: a tampered agent/policy/device yields NO key — never a
    // fallback/default/unsealed key.
    await expect(r.load()).rejects.toBeInstanceOf(MasterKeyUnavailableError);
    await expect(r.load()).rejects.toThrow(/measurement-mismatch/);
  });

  test("boot gate blocking secrets → key unavailable (throws)", async () => {
    const r = attestationMasterKey(
      refusingVerifier(
        "state-volume key release refused: TEE boot gate blocks secrets",
      ),
    );
    await expect(r.load()).rejects.toBeInstanceOf(MasterKeyUnavailableError);
    await expect(r.load()).rejects.toThrow(/boot gate blocks secrets/);
  });

  test("verifier returns a wrong-size buffer → rejected (no short key)", async () => {
    const r = attestationMasterKey(trustedVerifier(Buffer.alloc(16, 1)));
    await expect(r.load()).rejects.toBeInstanceOf(MasterKeyUnavailableError);
    await expect(r.load()).rejects.toThrow(/expected a 32-byte Buffer/);
  });

  test("describe surfaces the attestation provider for audit", () => {
    const r = attestationMasterKey(trustedVerifier(generateMasterKey()));
    expect(r.describe()).toBe("attestation://tdx-dstack");
  });
});
