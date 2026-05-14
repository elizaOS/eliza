import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ManifestSignatureError,
  verifyManifestSignature,
  verifyManifestSignatureText,
} from "./manifest-signature.js";

interface KeyPair {
  publicRaw: Uint8Array;
  privateKey: CryptoKey;
}

async function generateKeyPair(): Promise<KeyPair> {
  const { publicKey, privateKey } = (await webcrypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", publicKey),
  );
  return { publicRaw: raw, privateKey };
}

async function signBody(
  privateKey: CryptoKey,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const sig = new Uint8Array(
    await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, body),
  );
  return Buffer.from(sig).toString("base64");
}

describe("verifyManifestSignature", () => {
  it("accepts a body signed by the current key", async () => {
    const kp = await generateKeyPair();
    const body = new TextEncoder().encode('{"models":[]}');
    const sig = await signBody(kp.privateKey, body);
    const idx = await verifyManifestSignature({
      body,
      signatureBase64: sig,
      publicKeys: [kp.publicRaw],
    });
    expect(idx).toBe(0);
  });

  it("rejects when the signature was made by a different key", async () => {
    const kpA = await generateKeyPair();
    const kpB = await generateKeyPair();
    const body = new TextEncoder().encode('{"x":1}');
    const sig = await signBody(kpA.privateKey, body);
    await expect(
      verifyManifestSignature({
        body,
        signatureBase64: sig,
        publicKeys: [kpB.publicRaw],
      }),
    ).rejects.toBeInstanceOf(ManifestSignatureError);
  });

  it("accepts during rotation when the second key signs", async () => {
    const kpOld = await generateKeyPair();
    const kpNew = await generateKeyPair();
    const body = new TextEncoder().encode('{"rev":2}');
    const sig = await signBody(kpNew.privateKey, body);
    const idx = await verifyManifestSignature({
      body,
      signatureBase64: sig,
      publicKeys: [kpOld.publicRaw, kpNew.publicRaw],
    });
    expect(idx).toBe(1);
  });

  it("rejects when the body has been tampered with", async () => {
    const kp = await generateKeyPair();
    const body = new TextEncoder().encode('{"a":1}');
    const sig = await signBody(kp.privateKey, body);
    const tampered = new TextEncoder().encode('{"a":2}');
    await expect(
      verifyManifestSignature({
        body: tampered,
        signatureBase64: sig,
        publicKeys: [kp.publicRaw],
      }),
    ).rejects.toBeInstanceOf(ManifestSignatureError);
  });

  it("throws on empty public key list", async () => {
    const body = new Uint8Array([1, 2, 3]);
    await expect(
      verifyManifestSignature({
        body,
        signatureBase64: "AAAA",
        publicKeys: [],
      }),
    ).rejects.toThrow(/no public keys/);
  });

  it("rejects malformed base64 signatures", async () => {
    const kp = await generateKeyPair();
    await expect(
      verifyManifestSignature({
        body: new Uint8Array([1]),
        signatureBase64: "not%%%base64",
        publicKeys: [kp.publicRaw],
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong-length signatures", async () => {
    const kp = await generateKeyPair();
    await expect(
      verifyManifestSignature({
        body: new Uint8Array([1]),
        signatureBase64: Buffer.from(new Uint8Array(63)).toString("base64"),
        publicKeys: [kp.publicRaw],
      }),
    ).rejects.toThrow(/64 bytes/);
  });

  it("rejects wrong-length public keys", async () => {
    const body = new Uint8Array([1]);
    const sig = Buffer.from(new Uint8Array(64)).toString("base64");
    await expect(
      verifyManifestSignature({
        body,
        signatureBase64: sig,
        publicKeys: [new Uint8Array(31)],
      }),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe("verifyManifestSignatureText", () => {
  it("round-trips a JSON-looking body", async () => {
    const kp = await generateKeyPair();
    const body = '{"models":[{"id":"kokoro","version":"0.1.0"}]}';
    const sig = await signBody(kp.privateKey, new TextEncoder().encode(body));
    const idx = await verifyManifestSignatureText(body, sig, [kp.publicRaw]);
    expect(idx).toBe(0);
  });
});
