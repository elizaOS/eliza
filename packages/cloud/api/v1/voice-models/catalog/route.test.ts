/**
 * End-to-end behavioral test for the public voice-model catalog trust
 * boundary: drives the REAL route handler (packages/cloud/api/v1/voice-models/
 * catalog/route.ts) through Hono's app.request() with real generated Ed25519
 * credentials, then feeds the raw response bytes and X-Eliza-Signature header
 * to the REAL device-side verification path (`verifyManifestSignatureText`,
 * the same function plugin-local-inference's cloudCatalogSource calls before
 * parsing). Pins three contracts:
 * 1. valid credentials produce a signed catalog the device verifier accepts,
 *    and a tampered body fails exact-bytes verification;
 * 2. malformed signing credentials (junk character, interior whitespace,
 *    misplaced padding, non-zero slack bits) fail closed with NO signed or
 *    cacheable success — never a silently re-decoded "working" credential;
 * 3. malformed public-key env and a missing signing key behave the same.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { verifyManifestSignatureText } from "@elizaos/shared/local-inference/manifest-signature";
import app from "./route";

/** Ed25519 PKCS8 DER is 48 bytes: 16-byte RFC 8410 prefix + 32-byte seed. */
function seedB64From(privateKey: KeyObject): string {
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  expect(der.byteLength).toBe(48);
  return Buffer.from(der.subarray(16)).toString("base64");
}

/** SPKI DER for Ed25519 is 44 bytes: 12-byte prefix + 32-byte raw public key. */
function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  expect(spki.byteLength).toBe(44);
  return new Uint8Array(spki.subarray(12));
}

describe("GET /api/v1/voice-models/catalog (route + device verifier, e2e)", () => {
  let seedB64: string;
  let pubRaw: Uint8Array;
  let pubB64: string;

  beforeEach(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    seedB64 = seedB64From(privateKey);
    pubRaw = rawPublicKey(publicKey);
    pubB64 = Buffer.from(pubRaw).toString("base64");
  });

  function baseEnv(): Record<string, string> {
    return {
      ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64: seedB64,
      ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64: pubB64,
    };
  }

  async function fetchCatalog(env: Record<string, string | undefined>) {
    return app.request("/", {}, env);
  }

  test("valid credentials: route signs, device verifier accepts the exact bytes", async () => {
    const res = await fetchCatalog(baseEnv());
    expect(res.status).toBe(200);
    const signature = res.headers.get("X-Eliza-Signature");
    expect(signature).toBeTruthy();
    expect(res.headers.get("Content-Type")).toContain("application/json");
    // Cacheable success must only exist alongside a signature.
    expect(res.headers.get("Cache-Control")).toContain("s-maxage");

    const bodyText = await res.text();
    const parsed = JSON.parse(bodyText);
    expect(parsed.schema).toBe("eliza-1-voice-models.v1");
    expect(Array.isArray(parsed.versions)).toBe(true);
    expect(parsed.versions.length).toBeGreaterThan(0);

    // The device-side updater path: verify the signature over the EXACT
    // response text before parsing (same call cloudCatalogSource makes).
    const keyIndex = await verifyManifestSignatureText(bodyText, signature!, [
      pubRaw,
    ]);
    expect(keyIndex).toBe(0);

    // A single flipped byte in the body must fail exact-bytes verification.
    const tampered = bodyText.replace("eliza-1", "eliza-9");
    await expect(
      verifyManifestSignatureText(tampered, signature!, [pubRaw]),
    ).rejects.toThrow(/ELIZA_VOICE_SIG_REJECTED|no candidate public key/);
  });

  test("signature verifies against the rotation peer slot too (key list)", async () => {
    const other = generateKeyPairSync("ed25519");
    const res = await fetchCatalog(baseEnv());
    expect(res.status).toBe(200);
    const signature = res.headers.get("X-Eliza-Signature");
    const bodyText = await res.text();
    // Device configured with [rotationPeer, current]: index 1 must accept.
    const idx = await verifyManifestSignatureText(bodyText, signature!, [
      rawPublicKey(other.publicKey),
      pubRaw,
    ]);
    expect(idx).toBe(1);
  });

  const malformedSigningKeys: Array<[string, (seed: string) => string]> = [
    ["junk character appended", (s) => `${s}!`],
    // Whitespace INSIDE an otherwise valid spelling: a lenient decoder
    // silently discards it and the route would sign with "some" bytes —
    // this is the case that distinguishes strict from lenient decoding.
    [
      "interior whitespace inside a valid key",
      (s) => `${s.slice(0, 20)} ${s.slice(20)}`,
    ],
    ["misplaced leading padding", (s) => `=${s.slice(1)}`],
    [
      "non-zero slack bits in final quantum",
      (s) => {
        // Bump the last DATA character (before the trailing '=') so its two
        // discarded low bits become non-zero. For the four canonical
        // zero-slack chars (A/Q/g/w) the successor (B/R/h/x) is a guaranteed
        // same-bytes alias — a lenient decoder silently accepts the SAME key
        // bytes, and ONLY the canonical re-encode check rejects it. Any other
        // spelling is still a hand-mangled non-canonical quantum the guard
        // must reject. Decoded length stays 32 bytes and the alphabet test
        // still passes, so the length check cannot catch this class.
        const lastData = s[s.length - 2] ?? "";
        const alias: Record<string, string> = {
          A: "B",
          Q: "R",
          g: "h",
          w: "x",
        };
        const bumped = alias[lastData] ?? "B";
        return `${s.slice(0, -2)}${bumped}=`;
      },
    ],
  ];

  for (const [name, mangle] of malformedSigningKeys) {
    test(`malformed signing key (${name}) fails closed: no signature, no cacheable success`, async () => {
      const res = await fetchCatalog({
        ...baseEnv(),
        ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64: mangle(seedB64),
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.headers.get("X-Eliza-Signature")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBeNull();
      const bodyText = await res.text();
      // The failure body must not be a signable catalog payload.
      expect(JSON.parse(bodyText).schema).toBeUndefined();
    });
  }

  const malformedPublicKeys: Array<[string, (pub: string) => string]> = [
    ["junk character appended", (p) => `${p}!`],
    [
      "interior whitespace inside a valid key",
      (p) => `${p.slice(0, 20)} ${p.slice(20)}`,
    ],
    ["misplaced leading padding", (p) => `=${p.slice(1)}`],
    [
      "non-zero slack bits in final quantum",
      (p) => {
        const lastData = p[p.length - 2] ?? "";
        const alias: Record<string, string> = {
          A: "B",
          Q: "R",
          g: "h",
          w: "x",
        };
        const bumped = alias[lastData] ?? "B";
        return `${p.slice(0, -2)}${bumped}=`;
      },
    ],
  ];

  for (const [name, mangle] of malformedPublicKeys) {
    test(`malformed public key (${name}) fails closed: no signature`, async () => {
      const res = await fetchCatalog({
        ...baseEnv(),
        ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64: mangle(pubB64),
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(res.headers.get("X-Eliza-Signature")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBeNull();
    });
  }

  test("unconfigured signing key returns 503 service_unavailable, unsigned", async () => {
    const res = await fetchCatalog({
      ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64: pubB64,
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("X-Eliza-Signature")).toBeNull();
    const parsed = JSON.parse(await res.text());
    expect(parsed.error.type).toBe("service_unavailable");
  });

  test("surrounding whitespace on the signing key is the documented operator convenience and still signs", async () => {
    const res = await fetchCatalog({
      ...baseEnv(),
      ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64: `${seedB64}\n`,
    });
    expect(res.status).toBe(200);
    const signature = res.headers.get("X-Eliza-Signature");
    expect(signature).toBeTruthy();
    const bodyText = await res.text();
    await verifyManifestSignatureText(bodyText, signature!, [pubRaw]);
  });

  test("base64url-spelled credentials (JWK/JOSE tooling output) keep signing and verifying", async () => {
    // RFC 4648 §5 spellings decoded fine under Node's lenient decoder, so
    // deployments configured from JWK `d` / `basenc --base64url` exist in
    // the field and MUST NOT become 500s on a public endpoint. The key is
    // drawn until its base64 spelling contains a mappable character, so
    // the test always exercises the normalization path (never vacuous).
    const toUrl = (b64: string) =>
      b64.replaceAll("+", "-").replaceAll("/", "_");
    // Redraw until BOTH credentials contain a mappable char, so the seed
    // signing path AND the public-key fingerprint path are each exercised
    // through the normalization (never vacuous). P(both per draw) is about
    // 0.55, so 64 draws fail with probability ~1e-19; the assertions below
    // are hard guards.
    for (
      let i = 0;
      i < 64 && !(/[+/]/.test(seedB64) && /[+/]/.test(pubB64));
      i++
    ) {
      const kp = generateKeyPairSync("ed25519");
      seedB64 = seedB64From(kp.privateKey);
      pubRaw = rawPublicKey(kp.publicKey);
      pubB64 = Buffer.from(pubRaw).toString("base64");
    }
    expect(/[+/]/.test(seedB64)).toBe(true);
    expect(/[+/]/.test(pubB64)).toBe(true);
    const seedUrl = toUrl(seedB64);
    const pubUrl = toUrl(pubB64);
    const res = await fetchCatalog({
      ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64: seedUrl,
      ELIZA_VOICE_CATALOG_PUBLIC_KEY_BASE64: pubUrl,
    });
    expect(res.status).toBe(200);
    const signature = res.headers.get("X-Eliza-Signature");
    expect(signature).toBeTruthy();
    const bodyText = await res.text();
    await verifyManifestSignatureText(bodyText, signature!, [pubRaw]);
    const parsed = JSON.parse(bodyText);
    expect(parsed.publicKeyFingerprints).toContain(pubB64);
  });
});
