import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { KEY_BYTES } from "../src/crypto.js";
import {
  defaultMasterKey,
  inMemoryMasterKey,
  MasterKeyUnavailableError,
  passphraseMasterKey,
  passphraseMasterKeyFromEnv,
} from "../src/master-key.js";

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
    const a = passphraseMasterKey({ passphrase: "passphrase-one-aaaa", cost: 1024 });
    const b = passphraseMasterKey({ passphrase: "passphrase-two-bbbb", cost: 1024 });
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
    const a = passphraseMasterKey({ passphrase, service: "service-a", cost: 1024 });
    const b = passphraseMasterKey({ passphrase, service: "service-b", cost: 1024 });
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
      passphraseMasterKey({
        passphrase: undefined as unknown as string,
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
    prev = process.env.MILADY_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MILADY_VAULT_PASSPHRASE;
    else process.env.MILADY_VAULT_PASSPHRASE = prev;
  });

  test("returns null when env is unset", () => {
    delete process.env.MILADY_VAULT_PASSPHRASE;
    expect(passphraseMasterKeyFromEnv()).toBeNull();
  });

  test("returns null when env is an empty string", () => {
    process.env.MILADY_VAULT_PASSPHRASE = "";
    expect(passphraseMasterKeyFromEnv()).toBeNull();
  });

  test("returns a working resolver when env is set", async () => {
    process.env.MILADY_VAULT_PASSPHRASE = "fine-passphrase-from-env";
    const r = passphraseMasterKeyFromEnv();
    expect(r).not.toBeNull();
    if (!r) return;
    const k = await r.load();
    expect(k.length).toBe(KEY_BYTES);
  });

  test("rejects an env passphrase below the minimum length on load", async () => {
    process.env.MILADY_VAULT_PASSPHRASE = "tooshort";
    // Construction throws because the passphrase fails validation up-front.
    expect(() => passphraseMasterKeyFromEnv()).toThrow(
      MasterKeyUnavailableError,
    );
  });
});

describe("defaultMasterKey — fallback chain", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MILADY_VAULT_PASSPHRASE;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MILADY_VAULT_PASSPHRASE;
    else process.env.MILADY_VAULT_PASSPHRASE = prev;
  });

  test("falls back to passphrase when keychain unavailable AND env is set", async () => {
    process.env.MILADY_VAULT_PASSPHRASE = "fine-fallback-passphrase";
    // Force a guaranteed-bad keychain entry: an empty service yields a
    // construction error from @napi-rs/keyring on every platform.
    const r = defaultMasterKey({ service: "" });
    const k = await r.load();
    expect(k.length).toBe(KEY_BYTES);
  });

  // Windows Credential Manager accepts an empty service name in
  // `new Entry("", "...")` and returns the existing entry (or creates
  // one), so the "guaranteed-bad keychain entry" sentinel that works on
  // macOS Keychain and libsecret doesn't trigger a failure path here.
  // The fallback-chain error-message contract still holds on POSIX
  // platforms, which is the case the test is documenting.
  test.skipIf(process.platform === "win32")(
    "error message names every remediation when both fail",
    async () => {
      delete process.env.MILADY_VAULT_PASSPHRASE;
      const r = defaultMasterKey({ service: "" });
      await expect(r.load()).rejects.toThrow(MasterKeyUnavailableError);
      try {
        await r.load();
        throw new Error("expected throw");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/MILADY_VAULT_PASSPHRASE/);
      }
    },
  );

  test("describe surfaces both paths when passphrase env is set", () => {
    process.env.MILADY_VAULT_PASSPHRASE = "fine-test-passphrase-env";
    const r = defaultMasterKey({ service: "test" });
    expect(r.describe()).toContain("keychain://");
    expect(r.describe()).toContain("passphrase://");
  });

  test("describe shows only keychain when passphrase env is unset", () => {
    delete process.env.MILADY_VAULT_PASSPHRASE;
    const r = defaultMasterKey({ service: "test" });
    expect(r.describe()).toContain("keychain://");
    expect(r.describe()).not.toContain("passphrase://");
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
