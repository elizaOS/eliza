// VAPID JWT signing (ES256) — proves the JWT verifies under WebCrypto against
// the public key, has the right claims, and rejects malformed keys.
import { describe, expect, test } from "vitest";
import { base64UrlToBytes } from "./base64url";
import { buildVapidAuthHeader, pushEndpointAudience, signVapidJwt } from "./vapid";

/** Generate a fresh P-256 keypair and return base64url public/private strings. */
async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
  cryptoPublic: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const b64url = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return {
    publicKey: b64url(rawPub),
    privateKey: jwk.d as string,
    cryptoPublic: pair.publicKey,
  };
}

describe("pushEndpointAudience", () => {
  test("derives scheme+host origin from an endpoint", () => {
    expect(pushEndpointAudience("https://web.push.apple.com/abc/def?x=1")).toBe(
      "https://web.push.apple.com",
    );
  });

  test("throws on a garbage endpoint", () => {
    expect(() => pushEndpointAudience("not a url")).toThrow();
  });
});

describe("signVapidJwt", () => {
  test("produces a JWT that verifies under the public key with correct claims", async () => {
    const keys = await generateVapidKeys();
    const fixedNow = () => 1_700_000_000_000; // deterministic

    const jwt = await signVapidJwt({
      audience: "https://web.push.apple.com",
      subject: "mailto:push@example.com",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      now: fixedNow,
    });

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64).toBeTruthy();
    expect(payloadB64).toBeTruthy();
    expect(sigB64).toBeTruthy();

    // Header is ES256 JWT.
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64)));
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });

    // Claims.
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    expect(payload.aud).toBe("https://web.push.apple.com");
    expect(payload.sub).toBe("mailto:push@example.com");
    expect(payload.exp).toBe(Math.floor(fixedNow() / 1000) + 12 * 60 * 60);

    // Signature verifies (raw r||s ECDSA over the signing input).
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.cryptoPublic,
      base64UrlToBytes(sigB64),
      signingInput,
    );
    expect(ok).toBe(true);
  });

  test("signature is raw 64-byte r||s (not DER)", async () => {
    const keys = await generateVapidKeys();
    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:x@y.z",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    const sig = base64UrlToBytes(jwt.split(".")[2]);
    expect(sig.length).toBe(64);
  });

  test("respects an explicit expiry", async () => {
    const keys = await generateVapidKeys();
    const jwt = await signVapidJwt({
      audience: "https://a.b",
      subject: "mailto:x@y.z",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      expiresAt: 123456,
    });
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(jwt.split(".")[1])));
    expect(payload.exp).toBe(123456);
  });

  test("rejects a public key that is not a 65-byte uncompressed point", async () => {
    const keys = await generateVapidKeys();
    await expect(
      signVapidJwt({
        audience: "https://a.b",
        subject: "mailto:x@y.z",
        privateKey: keys.privateKey,
        publicKey: "AAAA", // too short
      }),
    ).rejects.toThrow(/65-byte uncompressed/);
  });
});

describe("buildVapidAuthHeader", () => {
  test("formats the single-header vapid scheme", () => {
    expect(buildVapidAuthHeader("JWT.HERE", "PUBKEY")).toBe("vapid t=JWT.HERE, k=PUBKEY");
  });
});
