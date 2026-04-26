import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-token-enc-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("token encryption envelope", () => {
  it("round-trips a JSON payload through AES-256-GCM", () => {
    const key = crypto.randomBytes(32);
    const original = JSON.stringify({
      accessToken: "ya29.fake",
      refreshToken: "1//refresh-fake",
      expiresAt: 1700000000000,
    });
    const envelope = encryptTokenPayload(original, key);
    expect(isEncryptedTokenEnvelope(envelope)).toBe(true);
    expect(envelope.ct).not.toContain("fake"); // ciphertext is opaque
    const restored = decryptTokenEnvelope(envelope, key);
    expect(restored).toBe(original);
  });

  it("produces a fresh IV per encryption", () => {
    const key = crypto.randomBytes(32);
    const a = encryptTokenPayload("hello", key);
    const b = encryptTokenPayload("hello", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects tampered ciphertext via the auth tag", () => {
    const key = crypto.randomBytes(32);
    const envelope = encryptTokenPayload("payload", key);
    const tampered = {
      ...envelope,
      ct: Buffer.from("evil").toString("base64"),
    };
    expect(() => decryptTokenEnvelope(tampered, key)).toThrow();
  });

  it("rejects a wrong key", () => {
    const key = crypto.randomBytes(32);
    const envelope = encryptTokenPayload("payload", key);
    const otherKey = crypto.randomBytes(32);
    expect(() => decryptTokenEnvelope(envelope, otherKey)).toThrow();
  });
});

describe("resolveTokenEncryptionKey", () => {
  it("uses ELIZA_TOKEN_ENCRYPTION_KEY when present (base64)", () => {
    const key = crypto.randomBytes(32);
    const resolved = resolveTokenEncryptionKey(tmpDir, {
      ELIZA_TOKEN_ENCRYPTION_KEY: key.toString("base64"),
    });
    expect(resolved.equals(key)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".encryption-key"))).toBe(false);
  });

  it("uses ELIZA_TOKEN_ENCRYPTION_KEY when present (hex)", () => {
    const key = crypto.randomBytes(32);
    const resolved = resolveTokenEncryptionKey(tmpDir, {
      ELIZA_TOKEN_ENCRYPTION_KEY: key.toString("hex"),
    });
    expect(resolved.equals(key)).toBe(true);
  });

  it("rejects an env-supplied key with the wrong length", () => {
    expect(() =>
      resolveTokenEncryptionKey(tmpDir, {
        ELIZA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(8).toString("base64"),
      }),
    ).toThrow(/32 bytes/);
  });

  it("creates and reuses .encryption-key when no env var is set", () => {
    const first = resolveTokenEncryptionKey(tmpDir, {});
    expect(first).toHaveLength(32);
    const filePath = path.join(tmpDir, ".encryption-key");
    expect(fs.existsSync(filePath)).toBe(true);
    if (process.platform !== "win32") {
      const stat = fs.statSync(filePath);
      // Mode bits 0o600 → owner rw, no group/other.
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const second = resolveTokenEncryptionKey(tmpDir, {});
    expect(second.equals(first)).toBe(true);
  });
});
