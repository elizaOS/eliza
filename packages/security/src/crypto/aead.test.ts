/**
 * Tests the AES-256-GCM helper against authenticated round-trips and rejection paths.
 */

import { describe, expect, it } from "vitest";
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  AeadError,
  aeadDecrypt,
  aeadEncrypt,
} from "./aead.js";

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed + index) % 256);
}

describe("AEAD AES-256-GCM helpers", () => {
  it("round-trips plaintext with authenticated associated data", () => {
    const key = bytes(AEAD_KEY_BYTES, 1);
    const plaintext = new TextEncoder().encode("secret payload");
    const aad = new TextEncoder().encode("tenant:a");

    const encrypted = aeadEncrypt(key, plaintext, aad);

    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(encrypted.nonce).toHaveLength(AEAD_NONCE_BYTES);
    expect(encrypted.authTag).toHaveLength(AEAD_TAG_BYTES);
    expect(
      new TextDecoder().decode(
        aeadDecrypt(
          key,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          aad,
        ),
      ),
    ).toBe("secret payload");
  });

  it("uses a fresh nonce for separate encryptions", () => {
    const key = bytes(AEAD_KEY_BYTES, 2);
    const plaintext = new TextEncoder().encode("same plaintext");
    const aad = new TextEncoder().encode("resource:a");

    const first = aeadEncrypt(key, plaintext, aad);
    const second = aeadEncrypt(key, plaintext, aad);

    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(
      false,
    );
    expect(
      Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext)),
    ).toBe(false);
  });

  it("rejects wrong keys, wrong AAD, and tampered tags", () => {
    const key = bytes(AEAD_KEY_BYTES, 3);
    const aad = new TextEncoder().encode("aad");
    const encrypted = aeadEncrypt(
      key,
      new TextEncoder().encode("payload"),
      aad,
    );

    expect(() =>
      aeadDecrypt(
        bytes(AEAD_KEY_BYTES, 4),
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        aad,
      ),
    ).toThrow(AeadError);
    expect(() =>
      aeadDecrypt(
        key,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        new TextEncoder().encode("different aad"),
      ),
    ).toThrow(/AEAD decrypt failed/);

    const tamperedTag = new Uint8Array(encrypted.authTag);
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 0xff;
    expect(() =>
      aeadDecrypt(key, encrypted.ciphertext, encrypted.nonce, tamperedTag, aad),
    ).toThrow(/AEAD decrypt failed/);
  });

  it("validates key, nonce, and tag lengths before decrypting", () => {
    const ciphertext = bytes(8, 10);
    const nonce = bytes(AEAD_NONCE_BYTES, 20);
    const tag = bytes(AEAD_TAG_BYTES, 30);
    const aad = bytes(8, 40);

    expect(() =>
      aeadEncrypt(bytes(AEAD_KEY_BYTES - 1, 1), ciphertext, aad),
    ).toThrow(`AEAD key must be ${AEAD_KEY_BYTES} bytes`);
    expect(() =>
      aeadDecrypt(bytes(AEAD_KEY_BYTES - 1, 1), ciphertext, nonce, tag),
    ).toThrow(`AEAD key must be ${AEAD_KEY_BYTES} bytes`);
    expect(() =>
      aeadDecrypt(
        bytes(AEAD_KEY_BYTES, 1),
        ciphertext,
        bytes(AEAD_NONCE_BYTES - 1, 1),
        tag,
      ),
    ).toThrow(`AEAD nonce must be ${AEAD_NONCE_BYTES} bytes`);
    expect(() =>
      aeadDecrypt(
        bytes(AEAD_KEY_BYTES, 1),
        ciphertext,
        nonce,
        bytes(AEAD_TAG_BYTES - 1, 1),
      ),
    ).toThrow(`AEAD tag must be ${AEAD_TAG_BYTES} bytes`);
  });

  it("requires non-empty authenticated associated data for encryption", () => {
    const key = bytes(AEAD_KEY_BYTES, 5);
    const plaintext = new TextEncoder().encode("payload");

    expect(() => aeadEncrypt(key, plaintext)).toThrow("AEAD aad is required");
    expect(() => aeadEncrypt(key, plaintext, new Uint8Array())).toThrow(
      "AEAD aad is required",
    );
  });
});
