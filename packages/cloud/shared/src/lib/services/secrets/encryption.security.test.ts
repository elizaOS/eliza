/**
 * Security remediation coverage for the cloud secrets envelope (#12229).
 *
 * - M4: `LocalKMSProvider.getMasterKey` must fail CLOSED when
 *   `SECRETS_MASTER_KEY` is unset — never silently derive the publicly-known
 *   all-zero key — unless `ALLOW_INSECURE_DEV_KMS=1` is explicitly set for local
 *   development.
 * - L6: `SecretsEncryptionService` binds an optional AAD into AES-256-GCM so a
 *   ciphertext relocated to a different row/column fails to decrypt.
 *
 * The crypto exercised here is the REAL LocalKMSProvider / SecretsEncryptionService
 * (AES-256-GCM via node:crypto) — nothing is mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DecryptionError, LocalKMSProvider, SecretsEncryptionService } from "./encryption";

const KEY = "a".repeat(64); // 32 bytes hex

describe("M4 — LocalKMSProvider fails closed without SECRETS_MASTER_KEY", () => {
  let prev: {
    key: string | undefined;
    node: string | undefined;
    optIn: string | undefined;
  };

  beforeEach(() => {
    prev = {
      key: process.env.SECRETS_MASTER_KEY,
      node: process.env.NODE_ENV,
      optIn: process.env.ALLOW_INSECURE_DEV_KMS,
    };
    delete process.env.SECRETS_MASTER_KEY;
    delete process.env.ALLOW_INSECURE_DEV_KMS;
  });

  afterEach(() => {
    if (prev.key === undefined) delete process.env.SECRETS_MASTER_KEY;
    else process.env.SECRETS_MASTER_KEY = prev.key;
    if (prev.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.node;
    if (prev.optIn === undefined) delete process.env.ALLOW_INSECURE_DEV_KMS;
    else process.env.ALLOW_INSECURE_DEV_KMS = prev.optIn;
  });

  test("non-prod boot with no key and no opt-in throws on first encrypt (no zero-key)", async () => {
    process.env.NODE_ENV = "development";
    const kms = new LocalKMSProvider();
    await expect(kms.generateDataKey()).rejects.toThrow(/SECRETS_MASTER_KEY is required/);
  });

  test("production with no key throws (unchanged)", async () => {
    process.env.NODE_ENV = "production";
    const kms = new LocalKMSProvider();
    await expect(kms.generateDataKey()).rejects.toThrow(/SECRETS_MASTER_KEY is required/);
  });

  test("production ignores the ALLOW_INSECURE_DEV_KMS opt-in and still throws", async () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_INSECURE_DEV_KMS = "1";
    const kms = new LocalKMSProvider();
    await expect(kms.generateDataKey()).rejects.toThrow(/SECRETS_MASTER_KEY is required/);
  });

  test("explicit ALLOW_INSECURE_DEV_KMS=1 in non-prod proceeds with an (insecure) key", async () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_DEV_KMS = "1";
    const kms = new LocalKMSProvider();
    const { plaintext, ciphertext } = await kms.generateDataKey();
    expect(plaintext.length).toBe(32);
    // round-trips under the same (dev) key
    const dek = await kms.decrypt(ciphertext);
    expect(Buffer.compare(dek, plaintext)).toBe(0);
  });

  test("a configured key works and does not require the opt-in", async () => {
    process.env.NODE_ENV = "development";
    process.env.SECRETS_MASTER_KEY = KEY;
    const kms = new LocalKMSProvider();
    const { plaintext, ciphertext } = await kms.generateDataKey();
    const dek = await kms.decrypt(ciphertext);
    expect(Buffer.compare(dek, plaintext)).toBe(0);
  });

  test("constructor-provided key bypasses the env requirement", async () => {
    process.env.NODE_ENV = "production";
    const kms = new LocalKMSProvider(KEY);
    const { plaintext } = await kms.generateDataKey();
    expect(plaintext.length).toBe(32);
  });
});

describe("L6 — SecretsEncryptionService AAD binds ciphertext to its coordinates", () => {
  const svc = new SecretsEncryptionService(new LocalKMSProvider(KEY));

  test("round-trips with a matching AAD", async () => {
    const aad = "vendor_connections|row-1|access_token";
    const enc = await svc.encrypt("super-secret-token", aad);
    const dec = await svc.decrypt(enc, aad);
    expect(dec).toBe("super-secret-token");
  });

  test("relocating a ciphertext to a different row/column fails to decrypt", async () => {
    const enc = await svc.encrypt("super-secret-token", "vendor_connections|row-1|access_token");
    // Attacker with DB-write copies the same envelope onto a different row.
    await expect(svc.decrypt(enc, "vendor_connections|row-2|access_token")).rejects.toThrow(
      DecryptionError,
    );
    // ...or a different column of the same row.
    await expect(svc.decrypt(enc, "vendor_connections|row-1|refresh_token")).rejects.toThrow(
      DecryptionError,
    );
  });

  test("an AAD-bound ciphertext cannot be read without the AAD", async () => {
    const enc = await svc.encrypt("super-secret-token", "table|row|col");
    await expect(svc.decrypt(enc)).rejects.toThrow(DecryptionError);
  });

  test("no-AAD path is unchanged (backward compatible)", async () => {
    const enc = await svc.encrypt("legacy-value");
    expect(await svc.decrypt(enc)).toBe("legacy-value");
  });

  test("rotate preserves the AAD binding", async () => {
    const aad = "table|row|col";
    const enc = await svc.encrypt("v", aad);
    const rotated = await svc.rotate(enc, aad);
    expect(await svc.decrypt(rotated, aad)).toBe("v");
    await expect(svc.decrypt(rotated, "table|other|col")).rejects.toThrow(DecryptionError);
  });
});
