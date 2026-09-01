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

/**
 * Generate a key pair whose base64 seed is GUARANTEED to contain a
 * URL-mappable character (`+` or `/`), so base64url tests are never
 * vacuous. A single draw misses with probability (31/32)^43 < 0.26, so
 * 32 draws fail with probability ~1e-19 — the bound throw below is a
 * hard guard, not a probabilistic pass.
 */
function generateKeyPairWithMappableSeed(): ReturnType<typeof generateKeyPairSync> {
  for (let i = 0; i < 32; i++) {
    const kp = generateKeyPairSync("ed25519");
    if (/[+/]/.test(seedFromPkcs8PrivateKey(kp.privateKey))) {
      return kp;
    }
  }
  throw new Error("32 consecutive draws without a mappable seed character (p ~1e-19)");
}

describe("buildVoiceModelCatalogBody", () => {
  test("pins the body shape: schema literal, ISO generatedAt, full in-binary version list, fingerprint passthrough", () => {
    const now = new Date("2026-08-26T04:00:00.000Z");
    const fingerprints = ["AkZiDEp0bWx0", "TmV4dEtleUZw=="];
    const body = buildVoiceModelCatalogBody({
      now,
      publicKeyFingerprints: fingerprints,
    });

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
      buildVoiceModelCatalogBody({
        now: new Date(),
        publicKeyFingerprints: [],
      }),
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
      buildVoiceModelCatalogBody({
        now: new Date(),
        publicKeyFingerprints: [],
      }),
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

  test("fails closed on malformed signing keys: junk characters are rejected, not silently discarded", async () => {
    // A corrupted or mistyped signing secret (e.g. a `!` pasted in, or an
    // interior space) must throw before any signing, rather than being
    // silently dropped by a lenient decoder and signing with "some" bytes:
    // the operator would believe a broken credential is working. This pins
    // the strict half of the decode contract — the flip side of the
    // whitespace-trim convenience asserted in the canonicalization tests.
    const { privateKey } = generateKeyPairSync("ed25519");
    const seedB64 = seedFromPkcs8PrivateKey(privateKey);
    await expect(
      signVoiceModelCatalog({ bodyText: "{}", secretKeyBase64: `${seedB64}!` }),
    ).rejects.toThrow(/Invalid base64/);
    await expect(
      signVoiceModelCatalog({ bodyText: "{}", secretKeyBase64: `ab cd` }),
    ).rejects.toThrow(/Invalid base64/);
    // The explicit operator convenience: surrounding whitespace (a key
    // read from a file routinely carries a trailing newline) is trimmed,
    // and the key still signs.
    const signatureB64 = await signVoiceModelCatalog({
      bodyText: "{}",
      secretKeyBase64: `${seedB64}\n`,
    });
    expect(b64ToBytes(signatureB64).byteLength).toBe(64);
  });

  test("base64url spellings of the seed sign with the identical signature", async () => {
    // RFC 4648 §5 URL-safe spellings (`-`/`_` for `+`/`/`) decode to the
    // SAME bytes, and JWK `d`, `basenc --base64url`, and most JOSE
    // tooling emit them — an operator configured from any of those has a
    // correctly-signing deployment, so the strict decoder must normalize
    // the alphabet rather than reject. The signatures must be identical
    // (same seed ⇒ same signature), not merely both-valid.
    // The key is drawn until its base64 spelling contains a mappable
    // character (helper guarantees it), so the test always exercises the
    // normalization path.
    const { privateKey } = generateKeyPairWithMappableSeed();
    const seedB64 = seedFromPkcs8PrivateKey(privateKey);
    const seedUrl = seedB64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    expect(/[+/]/.test(seedB64)).toBe(true);
    const bodyText = JSON.stringify({ schema: "eliza-1-voice-models.v1" });
    const sigStd = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedB64,
    });
    const sigUrl = await signVoiceModelCatalog({
      bodyText,
      secretKeyBase64: seedUrl,
    });
    expect(sigUrl).toBe(sigStd);
    // Mixed alphabets (standard +// and URL-safe -/_ in ONE credential)
    // are hand-mangled values no standard encoding emits: rejected even
    // though per-character substitution alone would normalize them. The
    // mixed spelling is built position-aware: keep the standard mappable
    // char, replace an unrelated alphanumeric char with `-`.
    const m = seedB64.search(/[+/]/);
    let j = 0;
    while (j === m || !/[A-Za-z0-9]/.test(seedB64[j] ?? "")) j += 1;
    const mixedSeed = `${seedB64.slice(0, j)}-${seedB64.slice(j + 1)}`;
    await expect(signVoiceModelCatalog({ bodyText, secretKeyBase64: mixedSeed })).rejects.toThrow(
      /mixed alphabets/,
    );
  });
});

describe("fingerprintPublicKey", () => {
  test("canonicalizes non-canonical base64 spellings to the same fingerprint", () => {
    // Surrounding whitespace is trimmed and unpadded spellings decode to
    // the same 32 bytes, so re-encoding emits the canonical spelling. This
    // is the realistic input class — a key pasted from a file routinely
    // carries a trailing newline — and the case that proves the function
    // does something a passthrough (return the input after the length
    // check) would not: the passthrough returns the newline-terminated
    // spelling.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    let rawB64 = Buffer.from(raw).toString("base64");
    expect(fingerprintPublicKey(`${rawB64}\n`)).toBe(rawB64);
    expect(fingerprintPublicKey(` ${rawB64}`)).toBe(rawB64);
    // 43-char unpadded spelling of the same 32 bytes also canonicalizes
    // to the padded form.
    expect(fingerprintPublicKey(rawB64.replaceAll("=", ""))).toBe(rawB64);
    // RFC 4648 §5 base64url spellings (`-`/`_`, padded or unpadded) are
    // the same bytes in the alphabet JWK/JOSE tooling emits — they must
    // canonicalize to the standard fingerprint, never throw. Redraw the
    // random key until its base64 spelling contains a mappable char so the
    // assertions always execute (p of 32 straight misses ~1e-19).
    while (!/[+/]/.test(rawB64)) {
      rawB64 = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    }
    const rawUrl = rawB64.replaceAll("+", "-").replaceAll("/", "_");
    expect(fingerprintPublicKey(rawUrl)).toBe(rawB64);
    expect(fingerprintPublicKey(rawUrl.replaceAll("=", ""))).toBe(rawB64);
    // Mixed alphabets in one credential are rejected, not normalized
    // (position-aware: keep the standard mappable char, swap an
    // unrelated alphanumeric char to `-`).
    const m = rawB64.search(/[+/]/);
    let j = 0;
    while (j === m || !/[A-Za-z0-9]/.test(rawB64[j] ?? "")) j += 1;
    expect(() => fingerprintPublicKey(`${rawB64.slice(0, j)}-${rawB64.slice(j + 1)}`)).toThrow(
      /mixed alphabets/,
    );
    // Non-base64 junk is NOT a spelling of the same bytes: it throws
    // rather than canonicalizing (mirrors the signing-key fail-closed
    // contract above — a mistyped key must be rejected, not silently
    // decoded).
    expect(() => fingerprintPublicKey(`${rawB64}!`)).toThrow(
      /outside the canonical base64 alphabet/,
    );
    // A final quantum with non-zero discarded slack bits (here the last
    // char bumped so the two unused bits are set — decodes to the same
    // 32 bytes) is a hand-mangled spelling, not a legitimate one: it
    // must throw rather than silently canonicalize.
    const mangledTail = `${rawB64.slice(0, -2)}B=`;
    if (mangledTail !== rawB64) {
      expect(() => fingerprintPublicKey(mangledTail)).toThrow(/Invalid base64/);
    }
  });

  test("rejects wrong-length public keys", () => {
    const shortB64 = Buffer.from(new Uint8Array(31)).toString("base64");
    const longB64 = Buffer.from(new Uint8Array(64)).toString("base64");
    expect(() => fingerprintPublicKey(shortB64)).toThrow(/32 bytes/);
    expect(() => fingerprintPublicKey(longB64)).toThrow(/32 bytes/);
  });

  test("identity on canonical input: a canonical spelling round-trips unchanged", () => {
    // Guards the other direction of the canonicalization contract: for a
    // key already in canonical form the fingerprint equals the input, so
    // storing/pinning fingerprints against operator-supplied canonical
    // keys is stable.
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const rawB64 = Buffer.from(raw).toString("base64");
    expect(fingerprintPublicKey(rawB64)).toBe(rawB64);
  });
});
