/**
 * Unit tests for AES-256-GCM connector-token encryption at rest: encrypt/decrypt
 * round-trip, envelope detection, key resolution from env var vs generated
 * keyfile, and cross-key decryption failure. Uses real Node crypto + a temp dir.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tok-enc-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

describe("encrypt/decrypt round-trip", () => {
  it("recovers the plaintext with the same key", () => {
    const env = encryptTokenPayload('{"access_token":"abc"}', KEY);
    expect(env.__enc).toBe("aes-256-gcm");
    expect(decryptTokenEnvelope(env, KEY)).toBe('{"access_token":"abc"}');
  });

  it("uses a fresh IV per call (ciphertext differs for the same input)", () => {
    const a = encryptTokenPayload("same", KEY);
    const b = encryptTokenPayload("same", KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a key of the wrong length on encrypt", () => {
    expect(() => encryptTokenPayload("x", Buffer.alloc(16, 1))).toThrow();
  });
});

describe("integrity / authentication", () => {
  it("fails to decrypt with the wrong key (GCM auth)", () => {
    const env = encryptTokenPayload("secret", KEY);
    expect(() => decryptTokenEnvelope(env, OTHER_KEY)).toThrow();
  });

  it("fails to decrypt a tampered ciphertext or tag", () => {
    const env = encryptTokenPayload("secret", KEY);
    const tamperedCt: EncryptedTokenEnvelope = {
      ...env,
      ct: Buffer.from("evil-payload").toString("base64"),
    };
    expect(() => decryptTokenEnvelope(tamperedCt, KEY)).toThrow();
    const tamperedTag: EncryptedTokenEnvelope = {
      ...env,
      tag: Buffer.alloc(16, 0).toString("base64"),
    };
    expect(() => decryptTokenEnvelope(tamperedTag, KEY)).toThrow();
  });

  it("rejects an unsupported algorithm or version", () => {
    const env = encryptTokenPayload("x", KEY);
    expect(() =>
      decryptTokenEnvelope({ ...env, __enc: "rot13" } as never, KEY),
    ).toThrow(/algorithm/i);
    expect(() => decryptTokenEnvelope({ ...env, v: 99 } as never, KEY)).toThrow(
      /version/i,
    );
  });
});

describe("isEncryptedTokenEnvelope", () => {
  it("recognizes a real envelope and rejects anything else", () => {
    expect(isEncryptedTokenEnvelope(encryptTokenPayload("x", KEY))).toBe(true);
    expect(isEncryptedTokenEnvelope({ __enc: "aes-256-gcm" })).toBe(true);
    expect(isEncryptedTokenEnvelope(null)).toBe(false);
    expect(isEncryptedTokenEnvelope("x")).toBe(false);
    expect(isEncryptedTokenEnvelope({ ct: "x" })).toBe(false);
  });
});

describe("resolveTokenEncryptionKey", () => {
  it("prefers the env var (hex or base64, 32 bytes)", () => {
    const hex = resolveTokenEncryptionKey(freshDir(), {
      ELIZA_TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
    } as NodeJS.ProcessEnv);
    expect(hex.equals(KEY)).toBe(true);

    const b64 = resolveTokenEncryptionKey(freshDir(), {
      ELIZA_TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
    } as NodeJS.ProcessEnv);
    expect(b64.equals(KEY)).toBe(true);
  });

  it("throws when the env key decodes to the wrong length", () => {
    expect(() =>
      resolveTokenEncryptionKey(freshDir(), {
        ELIZA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(8, 1).toString("base64"),
      } as NodeJS.ProcessEnv),
    ).toThrow(/32 bytes/);
  });

  it("generates and persists a key file when no env var is set", () => {
    const dir = freshDir();
    const env = {} as NodeJS.ProcessEnv;
    const first = resolveTokenEncryptionKey(dir, env);
    expect(first.length).toBe(32);
    expect(existsSync(join(dir, ".encryption-key"))).toBe(true);
    // Second call reuses the same persisted key.
    const second = resolveTokenEncryptionKey(dir, env);
    expect(second.equals(first)).toBe(true);
  });

  it("the generated key actually decrypts what it encrypted", () => {
    const dir = freshDir();
    const key = resolveTokenEncryptionKey(dir, {} as NodeJS.ProcessEnv);
    const env = encryptTokenPayload("round", key);
    const reread = resolveTokenEncryptionKey(dir, {} as NodeJS.ProcessEnv);
    expect(decryptTokenEnvelope(env, reread)).toBe("round");
  });
});
