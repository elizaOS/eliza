/**
 * Pins the sign-side behavior of the voice-model catalog service (schema
 * eliza-1-voice-models.v1): GET /api/v1/voice-models/catalog is public and
 * unauthenticated, and the device-side updater verifies the Ed25519 signature
 * in X-Eliza-Signature over the exact response text before parsing. These
 * tests prove the service builds the documented body shape and produces
 * signatures that verify (and stop verifying under tampering) with keys from
 * an external generator, and that keys of the wrong decoded length are
 * rejected. The HTTP route itself is out of scope here.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { VOICE_MODEL_VERSIONS } from "@elizaos/shared/local-inference/voice-models";
import {
  buildVoiceModelCatalogBody,
  fingerprintPublicKey,
  signVoiceModelCatalog,
} from "../voice-model-catalog";

/** Ed25519 PKCS8 DER is 48 bytes: 16-byte RFC 8410 prefix + 32-byte seed. */
function seedFromPkcs8PrivateKey(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  if (der.byteLength !== 48) {
    throw new Error(`expected 48-byte Ed25519 PKCS8 DER, got ${der.byteLength}`);
  }
  return Buffer.from(der.subarray(16)).toString("base64");
}

/** SPKI DER for Ed25519 is 44 bytes: 12-byte prefix + 32-byte raw public key. */
function rawPublicKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): Uint8Array {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  if (spki.byteLength !== 44) {
    throw new Error(`expected 44-byte Ed25519 SPKI DER, got ${spki.byteLength}`);
  }
  return new Uint8Array(spki.subarray(12));
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function importVerifyKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]) {
  return crypto.subtle.importKey(
    "raw",
    rawPublicKey(publicKey) as unknown as ArrayBuffer,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

describe("buildVoiceModelCatalogBody", () => {
  test("pins the body shape: schema literal, ISO generatedAt, full in-binary version list, fingerprint passthrough", () => {
    const now = new Date("2026-08-26T04:00:00.000Z");
    const fingerprints = ["AkZiDEp0bWx0", "TmV4dEtleUZw=="];
    const body = buildVoiceModelCatalogBody({ now, publicKeyFingerprints: fingerprints });

    expect(body.schema).toBe("eliza-1-voice-models.v1");
    // The device updater treats generatedAt as an ISO timestamp; a raw
    // epoch-ms number here would change every response body's semantics.
    expect(body.generatedAt).toBe("2026-08-26T04:00:00.000Z");
    // The served version list must carry every in-binary version — a
    // truncated or filtered list would hide models from devices.
    expect(body.versions).toEqual(VOICE_MODEL_VERSIONS);
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.versions.length).toBeGreaterThan(0);
    expect(body.publicKeyFingerprints).toEqual(fingerprints);
  });

  test("honors the injected clock: distinct dates produce distinct generatedAt values", () => {
    const a = buildVoiceModelCatalogBody({
      now: new Date("2026-01-01T00:00:00.000Z"),
      publicKeyFingerprints: [],
    });
    const b = buildVoiceModelCatalogBody({
      now: new Date("2026-01-01T00:00:01.000Z"),
      publicKeyFingerprints: [],
    });
    expect(a.generatedAt).not.toBe(b.generatedAt);
  });
});

describe("signVoiceModelCatalog", () => {
  test("signature verifies against an externally generated Ed25519 key pair", async () => {
    // The key pair comes from node:crypto and the seed is re-derived from
    // its PKCS8 DER, so this proves the module's RFC 8410 seed wrapping
    // matches Node's own key encoding, and that signing round-trips
    // through WebCrypto import/verify.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const bodyText = JSON.stringify(
      buildVoiceModelCatalogBody({
        now: new Date("2026-08-26T04:00:00.000Z"),
        publicKeyFingerprints: ["Zmlyc3Q=", "c2Vjb25k"],
      }),
    );

    const signatureB64 = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedFromPkcs8PrivateKey(privateKey),
    });

    // X-Eliza-Signature carries a base64 64-byte Ed25519 signature.
    const sigBytes = b64ToBytes(signatureB64);
    expect(sigBytes.byteLength).toBe(64);

    const verifyKey = await importVerifyKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      verifyKey,
      sigBytes as unknown as ArrayBuffer,
      new TextEncoder().encode(bodyText) as unknown as ArrayBuffer,
    );
    expect(valid).toBe(true);
  });

  test("signature verifies over a body containing multi-byte UTF-8 text", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const bodyText = JSON.stringify({
      schema: "eliza-1-voice-models.v1",
      note: "émoji ✓ 音声モデル",
    });

    const signatureB64 = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedFromPkcs8PrivateKey(privateKey),
    });

    const verifyKey = await importVerifyKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      verifyKey,
      b64ToBytes(signatureB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(bodyText) as unknown as ArrayBuffer,
    );
    expect(valid).toBe(true);
  });

  test("a single flipped body byte fails verification (exact-bytes contract)", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const bodyText = JSON.stringify(
      buildVoiceModelCatalogBody({ now: new Date(), publicKeyFingerprints: [] }),
    );
    const signatureB64 = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedFromPkcs8PrivateKey(privateKey),
    });

    const tampered = bodyText.replace("eliza-1", "eliza-2");
    expect(tampered).not.toBe(bodyText);
    const verifyKey = await importVerifyKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      verifyKey,
      b64ToBytes(signatureB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(tampered) as unknown as ArrayBuffer,
    );
    expect(valid).toBe(false);
  });

  test("a signature made with a different seed does not verify", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const bodyText = JSON.stringify(
      buildVoiceModelCatalogBody({ now: new Date(), publicKeyFingerprints: [] }),
    );
    const signatureB64 = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedFromPkcs8PrivateKey(other.privateKey),
    });

    const verifyKey = await importVerifyKey(publicKey);
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      verifyKey,
      b64ToBytes(signatureB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(bodyText) as unknown as ArrayBuffer,
    );
    expect(valid).toBe(false);
  });

  test("rejects keys whose decoded length is not exactly 32 bytes, before any signing", async () => {
    const tooShort = Buffer.from(new Uint8Array(31)).toString("base64");
    const tooLong = Buffer.from(new Uint8Array(33)).toString("base64");

    await expect(
      signVoiceModelCatalog({ bodyText: "{}", secretKeyBase64: tooShort }),
    ).rejects.toThrow(/32 bytes/);
    await expect(
      signVoiceModelCatalog({ bodyText: "{}", secretKeyBase64: tooLong }),
    ).rejects.toThrow(/32 bytes/);
    // An unconfigured (empty) signing key must fail closed rather than
    // sign anything — the route's own missing-env guard mirrors this.
    await expect(signVoiceModelCatalog({ bodyText: "{}", secretKeyBase64: "" })).rejects.toThrow(
      /32 bytes/,
    );
  });

  test("documents the decode boundary: non-base64 characters are ignored by the decoder, so length is the fail-closed gate", async () => {
    // Buffer-based base64 decoding is lenient: junk characters are
    // dropped, so a padded 44-char base64 seed with one appended invalid
    // character still decodes to the same 32 bytes and signs. Pinning that
    // boundary makes any future move
    // to strict decoding (which would reject such keys) a deliberate,
    // visible change rather than a silent one.
    const { privateKey } = generateKeyPairSync("ed25519");
    const seedB64 = seedFromPkcs8PrivateKey(privateKey);
    const signatureB64 = await signVoiceModelCatalog({
      bodyText: "{}",
      secretKeyBase64: `${seedB64}!`,
    });
    expect(b64ToBytes(signatureB64).byteLength).toBe(64);
  });
});

describe("fingerprintPublicKey", () => {
  test("base64-encodes a raw 32-byte public key unchanged", () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const rawB64 = Buffer.from(raw).toString("base64");
    expect(fingerprintPublicKey(rawB64)).toBe(rawB64);
  });

  test("rejects wrong-length public keys", () => {
    const shortB64 = Buffer.from(new Uint8Array(31)).toString("base64");
    const longB64 = Buffer.from(new Uint8Array(64)).toString("base64");
    expect(() => fingerprintPublicKey(shortB64)).toThrow(/32 bytes/);
    expect(() => fingerprintPublicKey(longB64)).toThrow(/32 bytes/);
  });
});
