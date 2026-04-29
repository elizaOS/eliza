import { describe, expect, it } from "vitest";
import {
  decrypt,
  encrypt,
  EnvelopeError,
  generateMasterKey,
  KEY_BYTES,
} from "../src/crypto/envelope.js";

describe("envelope (AES-256-GCM)", () => {
  it("roundtrips a value with matching AAD", () => {
    const key = generateMasterKey();
    const env = encrypt(key, "sk-or-v1-secret", "llm.openrouter.apiKey");
    expect(decrypt(key, env, "llm.openrouter.apiKey")).toBe("sk-or-v1-secret");
  });

  it("ciphertext format is `v1:nonce:tag:ct`", () => {
    const key = generateMasterKey();
    const { ciphertext } = encrypt(key, "x", "id.a.b");
    const parts = ciphertext.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1]!, "base64")).toHaveLength(12);
    expect(Buffer.from(parts[2]!, "base64")).toHaveLength(16);
  });

  it("decrypt with wrong AAD throws", () => {
    const key = generateMasterKey();
    const env = encrypt(key, "value", "id.a.b");
    expect(() => decrypt(key, env, "id.a.different")).toThrow(EnvelopeError);
  });

  it("decrypt with wrong key throws", () => {
    const key1 = generateMasterKey();
    const key2 = generateMasterKey();
    const env = encrypt(key1, "value", "id.a.b");
    expect(() => decrypt(key2, env, "id.a.b")).toThrow(EnvelopeError);
  });

  it("rejects ciphertext from a different version", () => {
    const key = generateMasterKey();
    const env = encrypt(key, "value", "id.a.b");
    const tampered = env.ciphertext.replace(/^v1:/, "v9:");
    expect(() => decrypt(key, tampered, "id.a.b")).toThrow(EnvelopeError);
  });

  it("rejects malformed envelope", () => {
    const key = generateMasterKey();
    expect(() => decrypt(key, "not:enough:parts", "id.a.b")).toThrow(
      EnvelopeError,
    );
  });

  it("rejects key of the wrong length", () => {
    const shortKey = Buffer.alloc(KEY_BYTES - 1);
    expect(() => encrypt(shortKey, "value", "id.a.b")).toThrow(EnvelopeError);
  });

  it("nonces are unique across consecutive encryptions of the same plaintext", () => {
    const key = generateMasterKey();
    const a = encrypt(key, "same", "id.a.b").ciphertext;
    const b = encrypt(key, "same", "id.a.b").ciphertext;
    expect(a).not.toBe(b);
  });

  it("tampered ciphertext is rejected (GCM auth)", () => {
    const key = generateMasterKey();
    const env = encrypt(key, "value", "id.a.b");
    const parts = env.ciphertext.split(":");
    // flip one byte of ct
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decrypt(key, parts.join(":"), "id.a.b")).toThrow(EnvelopeError);
  });
});
