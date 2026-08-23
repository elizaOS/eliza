/**
 * Unit tests for AES-256-GCM envelope encryption and decryption with AAD.
 */

import { describe, expect, it } from "vitest";
import {
  CryptoError,
  decrypt,
  encrypt,
  generateMasterKey,
  KEY_BYTES,
} from "./crypto.js";

describe("vault crypto", () => {
  it("generates a 32-byte master key", () => {
    const key = generateMasterKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(KEY_BYTES);
  });

  it("encrypts and decrypts plaintext roundtrip with authenticated additional data", () => {
    const masterKey = generateMasterKey();
    const secret = "sk-ant-api-key-very-secret-value-12345";
    const slotAad = "ANTHROPIC_API_KEY:default";

    const ciphertext = encrypt(masterKey, secret, slotAad);

    expect(ciphertext.startsWith("v1:")).toBe(true);
    expect(ciphertext.split(":")).toHaveLength(4);

    const decrypted = decrypt(masterKey, ciphertext, slotAad);
    expect(decrypted).toBe(secret);
  });

  it("fails decryption if master key does not match", () => {
    const masterKeyA = generateMasterKey();
    const masterKeyB = generateMasterKey();
    const ciphertext = encrypt(masterKeyA, "secret-text", "slot1");

    expect(() => decrypt(masterKeyB, ciphertext, "slot1")).toThrowError(
      CryptoError,
    );
  });

  it("fails decryption if AAD differs (slot swap prevention)", () => {
    const masterKey = generateMasterKey();
    const ciphertext = encrypt(masterKey, "secret-text", "slotA");

    expect(() => decrypt(masterKey, ciphertext, "slotB")).toThrowError(
      CryptoError,
    );
  });

  it("fails with CryptoError on invalid key length", () => {
    const shortKey = Buffer.alloc(16);
    expect(() => encrypt(shortKey, "text", "aad")).toThrowError(
      /master key must be 32 bytes/,
    );
    expect(() => decrypt(shortKey, "v1:a:b:c", "aad")).toThrowError(
      /master key must be 32 bytes/,
    );
  });

  it("fails with CryptoError on malformed ciphertext envelopes", () => {
    const masterKey = generateMasterKey();

    expect(() => decrypt(masterKey, "invalid-format", "aad")).toThrowError(
      /malformed ciphertext/,
    );
    expect(() => decrypt(masterKey, "v2:a:b:c", "aad")).toThrowError(
      /unsupported version/,
    );
    expect(() =>
      decrypt(masterKey, "v1:bad!nonce:bad!tag:bad!ct", "aad"),
    ).toThrowError(/malformed ciphertext/);
  });
});
