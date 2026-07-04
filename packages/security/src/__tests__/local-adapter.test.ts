/**
 * Tests the desktop local KMS adapter against deterministic root-key derivation and restart behavior.
 */

import { describe, expect, it } from "vitest";
import { orgKey, systemKey } from "../kms/key-namespace.js";
import { LocalKmsAdapter, randomRootKey } from "../kms/local-adapter.js";

const enc = (value: string) => new TextEncoder().encode(value);
const dec = (value: Uint8Array) => new TextDecoder().decode(value);

describe("LocalKmsAdapter", () => {
  it("decrypts ciphertext after restart when the same root key and version are supplied", async () => {
    const rootKey = randomRootKey();
    const keyId = orgKey("acme", "dek");
    const aad = enc("table=users|row=42|col=secret");
    const firstBoot = new LocalKmsAdapter({ rootKey });
    const encrypted = await firstBoot.encrypt(keyId, enc("persist me"), aad);

    const restarted = new LocalKmsAdapter({ rootKey });
    const plaintext = await restarted.decrypt(
      keyId,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      aad,
      encrypted.keyVersion,
    );

    expect(dec(plaintext)).toBe("persist me");
    expect(await restarted.listKeyVersions(keyId)).toEqual([1]);
  });

  it("rejects ciphertext on a different root key or different AAD", async () => {
    const keyId = systemKey("local-secret");
    const kms = new LocalKmsAdapter({ rootKey: randomRootKey() });
    const encrypted = await kms.encrypt(keyId, enc("secret"), enc("aad-a"));

    await expect(
      kms.decrypt(
        keyId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        enc("aad-b"),
        encrypted.keyVersion,
      ),
    ).rejects.toThrow();

    const otherInstall = new LocalKmsAdapter({ rootKey: randomRootKey() });
    await expect(
      otherInstall.decrypt(
        keyId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        enc("aad-a"),
        encrypted.keyVersion,
      ),
    ).rejects.toThrow();
  });

  it("requires AAD for encryption", async () => {
    const kms = new LocalKmsAdapter({ rootKey: randomRootKey() });
    const keyId = orgKey("acme", "dek");

    await expect(kms.encrypt(keyId, enc("secret"))).rejects.toThrow(
      "AEAD aad is required",
    );
    await expect(
      kms.encrypt(keyId, enc("secret"), new Uint8Array()),
    ).rejects.toThrow("AEAD aad is required");
  });

  it("does not trust caller-supplied key versions after failed decrypt", async () => {
    const rootKey = randomRootKey();
    const keyId = orgKey("acme", "dek");
    const kms = new LocalKmsAdapter({ rootKey });
    const encrypted = await kms.encrypt(keyId, enc("secret"), enc("aad-a"));

    await expect(
      kms.decrypt(
        keyId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        enc("aad-b"),
        999,
      ),
    ).rejects.toThrow();

    expect(await kms.listKeyVersions(keyId)).toEqual([1]);
  });

  it("keeps rotated symmetric versions decryptable across adapter instances", async () => {
    const rootKey = randomRootKey();
    const keyId = orgKey("acme", "dek");
    const aad = enc("resource=local-vault");
    const firstBoot = new LocalKmsAdapter({ rootKey });
    const v1 = await firstBoot.encrypt(keyId, enc("version one"), aad);
    await firstBoot.rotateKey(keyId);
    const v2 = await firstBoot.encrypt(keyId, enc("version two"), aad);

    expect(v1.keyVersion).toBe(1);
    expect(v2.keyVersion).toBe(2);

    const restarted = new LocalKmsAdapter({ rootKey });
    expect(
      dec(
        await restarted.decrypt(
          keyId,
          v1.ciphertext,
          v1.nonce,
          v1.authTag,
          aad,
          v1.keyVersion,
        ),
      ),
    ).toBe("version one");
    expect(
      dec(
        await restarted.decrypt(
          keyId,
          v2.ciphertext,
          v2.nonce,
          v2.authTag,
          aad,
          v2.keyVersion,
        ),
      ),
    ).toBe("version two");
    expect(await restarted.listKeyVersions(keyId)).toEqual([1, 2]);
  });

  it("separates HMAC keys by key id, root key, and HKDF domain", async () => {
    const rootKey = randomRootKey();
    const data = enc("payload");
    const first = new LocalKmsAdapter({ rootKey });
    const sameInstallRestarted = new LocalKmsAdapter({ rootKey });
    const sameKeyTag = await first.hmac(systemKey("audit"), data);

    expect(
      await sameInstallRestarted.hmacVerify(
        systemKey("audit"),
        data,
        sameKeyTag,
      ),
    ).toBe(true);
    expect(
      await first.hmacVerify(systemKey("audit-other"), data, sameKeyTag),
    ).toBe(false);
    expect(
      await new LocalKmsAdapter({ rootKey: randomRootKey() }).hmacVerify(
        systemKey("audit"),
        data,
        sameKeyTag,
      ),
    ).toBe(false);
  });

  it("keeps default signing keys stable across adapter instances with the same root key", async () => {
    const rootKey = randomRootKey();
    const keyId = systemKey("plugin-manifest");
    const data = enc("manifest bytes");
    const firstBoot = new LocalKmsAdapter({ rootKey });
    const signature = await firstBoot.sign(keyId, data);
    const publicKey = await firstBoot.getPublicKey(keyId);

    expect(await firstBoot.verify(keyId, data, signature.signature)).toBe(true);

    const restarted = new LocalKmsAdapter({ rootKey });
    expect(await restarted.verify(keyId, data, signature.signature)).toBe(true);
    expect(await restarted.getPublicKey(keyId)).toEqual(publicKey);

    const otherInstall = new LocalKmsAdapter({ rootKey: randomRootKey() });
    expect(await otherInstall.verify(keyId, data, signature.signature)).toBe(
      false,
    );
  });

  it("rejects malformed key ids at adapter boundaries", async () => {
    const kms = new LocalKmsAdapter({ rootKey: randomRootKey() });
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
