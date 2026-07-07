// aes128gcm Web Push payload encryption (RFC 8188 + RFC 8291).
// Proves the produced body has the correct aes128gcm header framing AND that a
// UA holding the matching private key can DECRYPT it (full round-trip = the
// key-derivation + GCM are correct, not just structurally plausible).
import { describe, expect, test } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./base64url";
import { encryptWebPushPayload } from "./encrypt";

/** A UA (browser) subscription keypair: p256dh (public) + auth secret. */
async function makeUaSubscription() {
  const uaPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaPair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: {
      p256dh: bytesToBase64Url(uaPublicRaw),
      auth: bytesToBase64Url(auth),
    },
    uaPrivate: uaPair.privateKey,
    uaPublicRaw,
    authBytes: auth,
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const nul = (s: string) => new TextEncoder().encode(`${s}\0`);
function concat(...cs: Uint8Array[]) {
  const out = new Uint8Array(cs.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of cs) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

describe("encryptWebPushPayload", () => {
  test("body has correct aes128gcm header framing", async () => {
    const ua = await makeUaSubscription();
    const { body } = await encryptWebPushPayload("hello", ua.keys);

    // header = salt(16) + rs(4) + idlen(1) + keyid(65) = 86, then ciphertext.
    expect(body.length).toBeGreaterThan(86);
    const idlen = body[20]; // after salt(16)+rs(4)
    expect(idlen).toBe(65); // the app-server ephemeral public point length
    const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
    expect(rs).toBe(4096);

    // keyid (as_public) is a valid uncompressed P-256 point.
    const asPublic = body.subarray(21, 21 + 65);
    expect(asPublic[0]).toBe(0x04);
  });

  test("round-trips: the UA private key decrypts the payload", async () => {
    const ua = await makeUaSubscription();
    const message = JSON.stringify({ title: "T", body: "B", badgeCount: 3 });
    const { body } = await encryptWebPushPayload(message, ua.keys);

    // Parse header.
    const salt = body.subarray(0, 16);
    const asPublicRaw = body.subarray(21, 21 + 65);
    const ciphertext = body.subarray(86);

    // Import as_public as ECDH, derive shared secret with UA private key.
    const asPublicKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64Url(asPublicRaw.subarray(1, 33)),
        y: bytesToBase64Url(asPublicRaw.subarray(33, 65)),
        ext: true,
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdhBits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: asPublicKey },
      ua.uaPrivate,
      256,
    );
    const ecdhSecret = new Uint8Array(ecdhBits);

    // PRK_key = HKDF(auth, ecdh, "WebPush: info\0"||ua_pub||as_pub, 32)
    const keyInfo = concat(nul("WebPush: info"), ua.uaPublicRaw, asPublicRaw);
    const prkKey = await hkdf(ua.authBytes, ecdhSecret, keyInfo, 32);
    const cek = await hkdf(salt, prkKey, nul("Content-Encoding: aes128gcm"), 16);
    const nonce = await hkdf(salt, prkKey, nul("Content-Encoding: nonce"), 12);

    const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      ciphertext,
    );
    const plain = new Uint8Array(plainBuf);

    // Strip the aes128gcm record delimiter (0x02) + any pad.
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0x00) end -= 1;
    expect(plain[end - 1]).toBe(0x02); // delimiter
    const decoded = new TextDecoder().decode(plain.subarray(0, end - 1));
    expect(JSON.parse(decoded)).toEqual({ title: "T", body: "B", badgeCount: 3 });
  });

  test("uses injected randomness + ephemeral key deterministically", async () => {
    const ua = await makeUaSubscription();
    const fixedSalt = new Uint8Array(16).fill(7);
    const asPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;

    const opts = {
      randomBytes: () => fixedSalt,
      generateKeyPair: async () => asPair,
    };
    const a = await encryptWebPushPayload("x", ua.keys, opts);
    const b = await encryptWebPushPayload("x", ua.keys, opts);
    // Same salt + same ephemeral key + same plaintext ⇒ identical body.
    expect(bytesToBase64Url(a.body)).toBe(bytesToBase64Url(b.body));
    // And the injected salt is what lands in the header.
    expect(Array.from(a.body.subarray(0, 16))).toEqual(Array.from(fixedSalt));
  });

  test("rejects a wrong-length auth secret", async () => {
    const ua = await makeUaSubscription();
    await expect(
      encryptWebPushPayload("x", {
        p256dh: ua.keys.p256dh,
        auth: bytesToBase64Url(new Uint8Array(8)), // wrong length
      }),
    ).rejects.toThrow(/auth secret must be 16 bytes/);
  });

  test("base64url round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
    expect(Array.from(base64UrlToBytes(bytesToBase64Url(bytes)))).toEqual(Array.from(bytes));
  });
});
