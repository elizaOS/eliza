/**
 * Tests the vault ciphertext envelope and authenticated-data binding.
 */

import { describe, expect, it } from "vitest";
import {
  CryptoError,
  decrypt,
  encrypt,
  generateMasterKey,
  KEY_BYTES,
} from "../src/vault/crypto.js";

describe("crypto envelope", () => {
  it("round-trips hostile string payloads", () => {
    const key = generateMasterKey();
    const payloads = [
      "",
      "colon:delimited:value",
      "line1\nline2\0tail",
      "emoji-\u{1f510}-and-cjk-\u79d8\u5bc6",
      "x".repeat(4096),
    ];

    for (const payload of payloads) {
      const ciphertext = encrypt(key, payload, "vault.key");
      expect(decrypt(key, ciphertext, "vault.key")).toBe(payload);
      expect(ciphertext).not.toContain(payload || "not-present");
    }
  });

  it("binds ciphertext to the aad/key slot", () => {
    const key = generateMasterKey();
    const ciphertext = encrypt(key, "secret", "slot.a");

    expect(() => decrypt(key, ciphertext, "slot.b")).toThrow(CryptoError);
  });

  // Fail-closed coverage for the #12740 sweep: a tampered ciphertext body or a
  // wrong master key must THROW (GCM auth-tag failure), never return a
  // fabricated/partial plaintext that a caller would trust as the real secret.
  it("throws on a bit-flipped ciphertext body (never returns fabricated plaintext)", () => {
    const key = generateMasterKey();
    const ciphertext = encrypt(key, "top-secret-value", "vault.key");
    const parts = ciphertext.split(":");
    const ctBuf = Buffer.from(parts[3] ?? "", "base64");
    // Flip one bit in the ciphertext body — GCM must reject on the auth tag.
    ctBuf[0] = (ctBuf[0] ?? 0) ^ 0x01;
    const tampered = `v1:${parts[1]}:${parts[2]}:${ctBuf.toString("base64")}`;

    expect(() => decrypt(key, tampered, "vault.key")).toThrow(CryptoError);
  });

  it("throws when decrypting with the wrong master key", () => {
    const key = generateMasterKey();
    const otherKey = generateMasterKey();
    const ciphertext = encrypt(key, "top-secret-value", "vault.key");

    expect(() => decrypt(otherKey, ciphertext, "vault.key")).toThrow(
      CryptoError,
    );
  });

  it("rejects wrong master-key sizes before encryption or decryption", () => {
    const badKey = Buffer.alloc(KEY_BYTES - 1);

    expect(() => encrypt(badKey, "secret", "slot")).toThrow(CryptoError);
    expect(() => decrypt(badKey, "v1:a:b:c", "slot")).toThrow(CryptoError);
  });

  it("rejects malformed or non-canonical base64 envelope fields", () => {
    const key = generateMasterKey();
    const valid = encrypt(key, "secret", "slot");
    const parts = valid.split(":");
    const nonce = parts[1];
    const tag = parts[2];
    const ct = parts[3];
    if (!nonce || !tag || ct === undefined) {
      throw new Error("unexpected test ciphertext shape");
    }

    const malformed = [
      "v2:abc:def:ghi",
      `v1:${nonce.slice(0, -1)}!:${tag}:${ct}`,
      `v1:${nonce}:${tag}\n:${ct}`,
      `v1:${nonce}:${tag}:not base64`,
      `v1::${tag}:${ct}`,
    ];

    for (const ciphertext of malformed) {
      expect(() => decrypt(key, ciphertext, "slot")).toThrow(CryptoError);
    }
  });
});
