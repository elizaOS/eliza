import { expect, test } from "vitest";
import { createKmsClient, LocalKmsAdapter, orgKey } from "./index";

const rootKey = new Uint8Array(32).fill(7);
const plaintext = new TextEncoder().encode("persistent secret");
const aad = new TextEncoder().encode("owner:alice");

test("local KMS survives restart and rejects cross-owner ciphertext and AAD", async () => {
  const keyId = orgKey("alice", "dek");
  const first = new LocalKmsAdapter({ rootKey });
  const encrypted = await first.encrypt(keyId, plaintext, aad);
  const restarted = new LocalKmsAdapter({ rootKey });
  const decrypt = (id: string, context: Uint8Array) =>
    restarted.decrypt(
      id,
      encrypted.ciphertext,
      encrypted.nonce,
      encrypted.authTag,
      context,
      encrypted.keyVersion,
    );
  expect(await decrypt(keyId, aad)).toEqual(plaintext);
  await expect(decrypt(orgKey("bob", "dek"), aad)).rejects.toThrow();
  await expect(
    decrypt(keyId, new TextEncoder().encode("owner:bob")),
  ).rejects.toThrow();
  const rotated = await restarted.rotateKey(keyId);
  const afterRotation = await restarted.encrypt(rotated.keyId, plaintext, aad);
  expect(afterRotation.keyVersion).toBe(2);
  expect(
    await new LocalKmsAdapter({ rootKey }).decrypt(
      rotated.keyId,
      afterRotation.ciphertext,
      afterRotation.nonce,
      afterRotation.authTag,
      aad,
      afterRotation.keyVersion,
    ),
  ).toEqual(plaintext);
  expect(await decrypt(keyId, aad)).toEqual(plaintext);
});

test("production local KMS requires a persistent root", () => {
  expect(() =>
    createKmsClient({ backend: "local", env: { NODE_ENV: "production" } }),
  ).toThrow("persistent root");
});
