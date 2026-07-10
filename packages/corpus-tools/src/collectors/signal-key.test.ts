/**
 * Signal key-acquisition tests. Exercises the real Chromium/Electron
 * safeStorage v10 scheme by encrypting a known key with a known Keychain
 * password in-test and asserting the unwrap recovers it byte-for-byte, plus the
 * config.json plaintext path and every fail-closed branch (wrong password, bad
 * prefix, missing key, unreadable config). No mock of the module under test — the
 * only injected seam is the Keychain reader.
 */
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCollectorError } from "./errors.ts";
import { resolveSignalKey, unwrapSafeStorageKey } from "./signal-key.ts";

const SAMPLE_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEYCHAIN_PASSWORD = "s3cr3t-safe-storage-password";

/** Produce a genuine OSCrypt v10 blob so the unwrap is tested against real bytes. */
function encryptV10(plaintext: string, password: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from("v10", "utf8"), body]);
}

async function writeConfig(contents: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "signal-key-"));
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

describe("unwrapSafeStorageKey", () => {
  it("round-trips a real v10 blob with the correct password", () => {
    const blob = encryptV10(SAMPLE_KEY, KEYCHAIN_PASSWORD);
    expect(unwrapSafeStorageKey(blob, KEYCHAIN_PASSWORD)).toBe(SAMPLE_KEY);
  });

  it("fails closed on the wrong password", () => {
    const blob = encryptV10(SAMPLE_KEY, KEYCHAIN_PASSWORD);
    try {
      unwrapSafeStorageKey(blob, "wrong-password");
      throw new Error("expected a decrypt failure");
    } catch (error) {
      expect(isCollectorError(error, "key_decrypt_failed")).toBe(true);
    }
  });

  it("rejects a blob without the v10 prefix", () => {
    const blob = Buffer.concat([
      Buffer.from("v11", "utf8"),
      Buffer.alloc(32, 1),
    ]);
    try {
      unwrapSafeStorageKey(blob, KEYCHAIN_PASSWORD);
      throw new Error("expected a prefix failure");
    } catch (error) {
      expect(isCollectorError(error, "key_decrypt_failed")).toBe(true);
    }
  });
});

describe("resolveSignalKey", () => {
  it("returns the plaintext legacy key", async () => {
    const configPath = await writeConfig({ key: SAMPLE_KEY });
    expect(await resolveSignalKey({ configPath })).toBe(SAMPLE_KEY);
  });

  it("normalizes an uppercase hex key to lowercase", async () => {
    const configPath = await writeConfig({ key: SAMPLE_KEY.toUpperCase() });
    expect(await resolveSignalKey({ configPath })).toBe(SAMPLE_KEY);
  });

  it("unwraps an encrypted key via the injected Keychain reader", async () => {
    const encryptedKey = encryptV10(SAMPLE_KEY, KEYCHAIN_PASSWORD).toString(
      "hex",
    );
    const configPath = await writeConfig({ encryptedKey });
    const key = await resolveSignalKey({
      configPath,
      readKeychainPassword: () => KEYCHAIN_PASSWORD,
    });
    expect(key).toBe(SAMPLE_KEY);
  });

  it("fails closed when an encrypted key has no Keychain reader", async () => {
    const encryptedKey = encryptV10(SAMPLE_KEY, KEYCHAIN_PASSWORD).toString(
      "hex",
    );
    const configPath = await writeConfig({ encryptedKey });
    try {
      await resolveSignalKey({ configPath });
      throw new Error("expected a key-source failure");
    } catch (error) {
      expect(isCollectorError(error, "key_source_unavailable")).toBe(true);
    }
  });

  it("fails closed on a config with neither key form", async () => {
    const configPath = await writeConfig({ version: 7 });
    try {
      await resolveSignalKey({ configPath });
      throw new Error("expected a key-source failure");
    } catch (error) {
      expect(isCollectorError(error, "key_source_unavailable")).toBe(true);
    }
  });

  it("fails closed on a non-hex resolved key", async () => {
    const configPath = await writeConfig({ key: "not-a-hex-key" });
    try {
      await resolveSignalKey({ configPath });
      throw new Error("expected a decrypt-format failure");
    } catch (error) {
      expect(isCollectorError(error, "key_decrypt_failed")).toBe(true);
    }
  });

  it("fails closed on a missing config file", async () => {
    try {
      await resolveSignalKey({ configPath: "/no/such/config.json" });
      throw new Error("expected a source-missing failure");
    } catch (error) {
      expect(isCollectorError(error, "source_missing")).toBe(true);
    }
  });
});
