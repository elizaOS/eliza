/**
 * Tests the in-memory KMS adapter's AEAD, HMAC, signing, and rotation contracts.
 */

import { describe, expect, it } from "vitest";
import { orgKey, systemKey } from "../kms/key-namespace.js";
import { MemoryKmsAdapter } from "../kms/memory-adapter.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("MemoryKmsAdapter", () => {
  it("round-trips encrypt/decrypt with AAD", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = orgKey("acme", "dek");
    const aad = enc("table=users|row=42|col=ssn");
    const result = await kms.encrypt(keyId, enc("hello world"), aad);
    expect(result.nonce.length).toBe(12);
    expect(result.authTag.length).toBe(16);
    expect(result.keyVersion).toBe(1);

    const pt = await kms.decrypt(
      keyId,
      result.ciphertext,
      result.nonce,
      result.authTag,
      aad,
      result.keyVersion,
    );
    expect(dec(pt)).toBe("hello world");
  });

  it("AAD mismatch fails decrypt", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("webhook-stripe");
    const result = await kms.encrypt(keyId, enc("secret"), enc("aad-a"));
    await expect(
      kms.decrypt(
        keyId,
        result.ciphertext,
        result.nonce,
        result.authTag,
        enc("aad-b"),
      ),
    ).rejects.toThrow();
  });

  it("requires AAD for encryption", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = orgKey("acme", "dek");

    await expect(kms.encrypt(keyId, enc("secret"))).rejects.toThrow(
      "AEAD aad is required",
    );
    await expect(
      kms.encrypt(keyId, enc("secret"), new Uint8Array()),
    ).rejects.toThrow("AEAD aad is required");
  });

  it("HMAC matches itself, rejects tampered tag", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = orgKey("acme", "hmac");
    const data = enc("payload");
    const tag = await kms.hmac(keyId, data);
    expect(await kms.hmacVerify(keyId, data, tag)).toBe(true);
    const tampered = new Uint8Array(tag);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    expect(await kms.hmacVerify(keyId, data, tampered)).toBe(false);
  });

  it("rotation: old version still decryptable, new version encrypts as v2", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = orgKey("acme", "dek");
    const aad = enc("table=t|row=1");
    const v1 = await kms.encrypt(keyId, enc("v1-secret"), aad);
    const { newVersion } = await kms.rotateKey(keyId);
    expect(newVersion).toBe(2);

    const v2 = await kms.encrypt(keyId, enc("v2-secret"), aad);
    expect(v2.keyVersion).toBe(2);

    // Old ciphertext still decryptable using its embedded version.
    const back = await kms.decrypt(
      keyId,
      v1.ciphertext,
      v1.nonce,
      v1.authTag,
      aad,
      v1.keyVersion,
    );
    expect(dec(back)).toBe("v1-secret");

    const versions = await kms.listKeyVersions(keyId);
    expect(versions).toEqual([1, 2]);
  });

  it("Ed25519 sign/verify, tampered data fails", async () => {
    const kms = new MemoryKmsAdapter();
    const keyId = systemKey("plugin-manifest");
    const data = enc("manifest-bytes");
    const sig = await kms.sign(keyId, data);
    expect(sig.algorithm).toBe("ed25519");
    expect(await kms.verify(keyId, data, sig.signature)).toBe(true);
    expect(await kms.verify(keyId, enc("manifest-bytes!"), sig.signature)).toBe(
      false,
    );
    const pub = await kms.getPublicKey(keyId);
    expect(pub.length).toBeGreaterThan(0);
  });

  it("rejects malformed key ids at adapter boundaries", async () => {
    const kms = new MemoryKmsAdapter();
    const malformed = "system:webhook-stripe";

    await expect(kms.getOrCreateKey(malformed)).rejects.toThrow(
      "malformed key id",
    );
    await expect(
      kms.encrypt(malformed, enc("secret"), enc("aad")),
    ).rejects.toThrow("malformed key id");
    await expect(kms.hmac(malformed, enc("payload"))).rejects.toThrow(
      "malformed key id",
    );
    await expect(kms.sign(malformed, enc("payload"))).rejects.toThrow(
      "malformed key id",
    );
  });
});
