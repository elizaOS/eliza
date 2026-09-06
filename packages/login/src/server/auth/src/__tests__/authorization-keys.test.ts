import { describe, expect, test } from "bun:test";

import {
  generateP256KeyPair,
  importP256PublicKey,
  signP256,
  verifyP256Signature,
} from "../authorization-keys";

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("decodeFlexible hex/base64 disambiguation (SEC-063)", () => {
  test("bare-hex raw-point public keys import and verify", async () => {
    const kp = await generateP256KeyPair();
    const rawHex = bytesToHex(base64ToBytes(kp.publicKeyRawBase64));
    // Guard the premise: this bare-hex string is ALSO valid base64 alphabet,
    // so a base64-first decode misreads it (the bug being regressed against).
    expect(/^[0-9a-fA-F]+$/.test(rawHex)).toBe(true);

    const key = await importP256PublicKey(rawHex);
    expect(key).not.toBeNull();

    const message = "steward:test:sec063";
    const signature = await signP256(kp.privateKey, message);
    expect(await verifyP256Signature(rawHex, message, signature)).toBe(true);
  });

  test("bare-hex SPKI public keys import", async () => {
    const kp = await generateP256KeyPair();
    const spkiHex = bytesToHex(base64ToBytes(kp.publicKeySpkiBase64));
    const key = await importP256PublicKey(spkiHex);
    expect(key).not.toBeNull();

    const message = "steward:test:sec063-spki";
    const signature = await signP256(kp.privateKey, message);
    expect(await verifyP256Signature(spkiHex, message, signature)).toBe(true);
  });

  test("bare-hex P1363 signatures verify against base64 keys", async () => {
    const kp = await generateP256KeyPair();
    const message = "steward:test:sec063-sig";
    const sigHex = bytesToHex(
      base64ToBytes(await signP256(kp.privateKey, message)),
    );
    expect(/^[0-9a-fA-F]+$/.test(sigHex)).toBe(true);
    expect(
      await verifyP256Signature(kp.publicKeySpkiBase64, message, sigHex),
    ).toBe(true);
  });

  test("base64 encodings still take precedence and verify", async () => {
    const kp = await generateP256KeyPair();
    const message = "steward:test:sec063-base64";
    const signature = await signP256(kp.privateKey, message);
    expect(
      await verifyP256Signature(kp.publicKeySpkiBase64, message, signature),
    ).toBe(true);
    expect(
      await verifyP256Signature(kp.publicKeyRawBase64, message, signature),
    ).toBe(true);
  });

  test("garbage input still fails closed", async () => {
    expect(await importP256PublicKey("not-a-key!!!")).toBeNull();
    expect(await verifyP256Signature("not-a-key!!!", "m", "c2ln")).toBe(false);
  });

  test("oversized base64 padding fails closed without regex backtracking", async () => {
    expect(
      await importP256PublicKey(`not-a-key${"=".repeat(200_000)}`),
    ).toBeNull();
    const nearMiss = `not-a-key${"=".repeat(200_000)}!`;
    expect(await importP256PublicKey(nearMiss)).toBeNull();
    expect(await verifyP256Signature(nearMiss, "message", nearMiss)).toBe(
      false,
    );
  });
});
