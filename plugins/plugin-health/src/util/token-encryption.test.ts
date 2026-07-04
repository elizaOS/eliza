/**
 * Unit test for the AES-256-GCM connector-token encryption helpers, covering
 * env-key and generated-key-file paths against a temp credentials dir.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decryptTokenEnvelope,
  type EncryptedTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

/**
 * Connector OAuth tokens are encrypted at rest with AES-256-GCM. The security
 * properties that matter: a correct round-trip, fresh IV per encryption, and
 * authenticated decryption that rejects a tampered blob or a wrong key.
 */

const KEY = crypto.randomBytes(32);
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

const mkTmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-tokenc-"));
  tmpDirs.push(dir);
  return dir;
};

describe("encrypt/decrypt round-trip", () => {
  it("recovers the exact plaintext", () => {
    const plaintext = JSON.stringify({ access: "tok-123", refresh: "r-456" });
    const env = encryptTokenPayload(plaintext, KEY);
    expect(env.__enc).toBe("aes-256-gcm");
    expect(env.v).toBe(1);
    expect(decryptTokenEnvelope(env, KEY)).toBe(plaintext);
  });

  it("uses a fresh IV/ciphertext for each encryption of the same input", () => {
    const a = encryptTokenPayload("same", KEY);
    const b = encryptTokenPayload("same", KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(decryptTokenEnvelope(a, KEY)).toBe("same");
    expect(decryptTokenEnvelope(b, KEY)).toBe("same");
  });

  it("rejects a key of the wrong length on encrypt", () => {
    expect(() => encryptTokenPayload("x", crypto.randomBytes(16))).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe("authenticated decryption", () => {
  const env = encryptTokenPayload("secret", KEY);

  it("fails on a tampered ciphertext", () => {
    const ctBuf = Buffer.from(env.ct, "base64");
    ctBuf[0] ^= 0xff;
    const tampered: EncryptedTokenEnvelope = {
      ...env,
      ct: ctBuf.toString("base64"),
    };
    expect(() => decryptTokenEnvelope(tampered, KEY)).toThrow();
  });

  it("fails on a tampered auth tag", () => {
    const tagBuf = Buffer.from(env.tag, "base64");
    tagBuf[0] ^= 0xff;
    expect(() =>
      decryptTokenEnvelope({ ...env, tag: tagBuf.toString("base64") }, KEY),
    ).toThrow();
  });

  it("fails with the wrong key", () => {
    expect(() => decryptTokenEnvelope(env, crypto.randomBytes(32))).toThrow();
  });

  it("rejects an unsupported algorithm or version", () => {
    expect(() =>
      decryptTokenEnvelope(
        { ...env, __enc: "rot13" } as unknown as EncryptedTokenEnvelope,
        KEY,
      ),
    ).toThrow(/Unsupported token envelope algorithm/);
    expect(() =>
      decryptTokenEnvelope(
        { ...env, v: 2 } as unknown as EncryptedTokenEnvelope,
        KEY,
      ),
    ).toThrow(/Unsupported token envelope version/);
  });
});

describe("isEncryptedTokenEnvelope", () => {
  it("recognizes envelopes and rejects everything else", () => {
    expect(isEncryptedTokenEnvelope(encryptTokenPayload("x", KEY))).toBe(true);
    expect(isEncryptedTokenEnvelope({ __enc: "other" })).toBe(false);
    expect(isEncryptedTokenEnvelope(null)).toBe(false);
    expect(isEncryptedTokenEnvelope([])).toBe(false);
    expect(isEncryptedTokenEnvelope("string")).toBe(false);
  });
});

describe("resolveTokenEncryptionKey", () => {
  it("decodes a hex env key", () => {
    const hex = KEY.toString("hex");
    const key = resolveTokenEncryptionKey("/unused", {
      ELIZA_TOKEN_ENCRYPTION_KEY: hex,
    } as NodeJS.ProcessEnv);
    expect(key.equals(KEY)).toBe(true);
  });

  it("decodes a base64 env key", () => {
    const key = resolveTokenEncryptionKey("/unused", {
      ELIZA_TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
    } as NodeJS.ProcessEnv);
    expect(key.equals(KEY)).toBe(true);
  });

  it("throws on a key that decodes to the wrong length", () => {
    expect(() =>
      resolveTokenEncryptionKey("/unused", {
        ELIZA_TOKEN_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      } as NodeJS.ProcessEnv),
    ).toThrow(/exactly 32 bytes/);
  });

  it("lazily creates a 0600 key file and reuses it across calls", () => {
    const dir = mkTmp();
    const credDir = path.join(dir, "creds");
    const first = resolveTokenEncryptionKey(credDir, {} as NodeJS.ProcessEnv);
    expect(first.length).toBe(32);
    const keyFile = path.join(credDir, ".encryption-key");
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const second = resolveTokenEncryptionKey(credDir, {} as NodeJS.ProcessEnv);
    expect(second.equals(first)).toBe(true);
  });
});
