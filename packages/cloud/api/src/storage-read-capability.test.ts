/**
 * Proves that private storage read capabilities authorize only the exact
 * Worker host, tenant-scoped object, method, purpose, and bounded time window
 * signed by a configured HMAC key, including safe key rotation and hostile
 * token parsing.
 */

import { describe, expect, test } from "bun:test";
import {
  mintStorageReadCapabilityUrl,
  normalizeStorageReadCapabilityHost,
  STORAGE_READ_CAPABILITY_PATH_PREFIX,
  StorageReadCapabilityConfigurationError,
  verifyStorageReadCapability,
} from "./storage-read-capability";

const NOW = Math.floor(Date.parse("2026-08-17T12:00:00.000Z") / 1000);
const NEW_SECRET = "new-storage-read-secret-000000000000000000000001";
const OLD_SECRET = "old-storage-read-secret-000000000000000000000002";
const HOST = "blob.example.test";
const SCOPED_KEY = "org/00000000-0000-4000-8000-000000021045/voice/message.ogg";

interface TestWireClaims {
  v: number;
  p: string;
  h: string;
  m: string;
  k: string;
  iat: number;
  exp: number;
}

function verificationInput(
  url: string,
  overrides?: { method?: string; now?: number },
) {
  return {
    rawSecrets: NEW_SECRET,
    url: new URL(url),
    method: overrides?.method ?? "GET",
    now: overrides?.now ?? NOW,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function signedTestUrl(
  claims: TestWireClaims,
  secret = NEW_SECRET,
): Promise<string> {
  const encoder = new TextEncoder();
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v1.${payload}`),
  );
  return `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function decodeWireClaims(url: string): {
  claims: TestWireClaims;
  payload: string;
  signature: string;
} {
  const token = new URL(url).pathname.slice(
    STORAGE_READ_CAPABILITY_PATH_PREFIX.length,
  );
  const [, payload, signature] = token.split(".");
  const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
  const json = atob(`${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`);
  return {
    claims: JSON.parse(json) as TestWireClaims,
    payload,
    signature,
  };
}

describe("storage read capability", () => {
  test("normalizes case, HTTPS default ports, and IDNA for every boundary", () => {
    expect(
      normalizeStorageReadCapabilityHost("  BLOB.Example.Test:443  "),
    ).toBe(HOST);
    expect(normalizeStorageReadCapabilityHost("BÜCHER.Example:8443")).toBe(
      "xn--bcher-kva.example:8443",
    );
  });

  test("rejects hosts that contain a scheme, path, credentials, or no hostname", () => {
    for (const host of [
      "",
      "https://blob.example.test",
      "blob.example.test/private",
      "user:password@blob.example.test",
    ]) {
      expect(() => normalizeStorageReadCapabilityHost(host)).toThrow(
        StorageReadCapabilityConfigurationError,
      );
      try {
        normalizeStorageReadCapabilityHost(host);
      } catch (error) {
        // error-policy:J3 invalid test inputs must map to the safe public error.
        expect(error).toMatchObject({ code: "invalid_host" });
      }
    }
  });

  test("round-trips a normalized HTTPS host and exact tenant-scoped key", async () => {
    const url = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: "  BLOB.Example.Test:443  ",
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });

    expect(url).toStartWith(
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.`,
    );
    expect(new URL(url).search).toBe("");
    expect(
      new URL(url).pathname.slice(STORAGE_READ_CAPABILITY_PATH_PREFIX.length),
    ).toMatch(/^[A-Za-z0-9._-]+$/u);

    await expect(
      verifyStorageReadCapability(verificationInput(url)),
    ).resolves.toEqual({
      ok: true,
      claims: {
        version: 1,
        purpose: "storage-read",
        host: HOST,
        method: "GET",
        scopedKey: SCOPED_KEY,
        issuedAt: NOW,
        expiresAt: NOW + 600,
      },
    });
    await expect(
      verifyStorageReadCapability(verificationInput(url, { method: "HEAD" })),
    ).resolves.toMatchObject({ ok: true });
  });

  test("rotates by signing with the first secret and verifying every secret", async () => {
    const oldUrl = await mintStorageReadCapabilityUrl({
      rawSecrets: OLD_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });
    await expect(
      verifyStorageReadCapability({
        ...verificationInput(oldUrl),
        rawSecrets: `${NEW_SECRET},${OLD_SECRET}`,
      }),
    ).resolves.toMatchObject({ ok: true });

    const newUrl = await mintStorageReadCapabilityUrl({
      rawSecrets: `${NEW_SECRET},${OLD_SECRET}`,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });
    await expect(
      verifyStorageReadCapability({
        ...verificationInput(newUrl),
        rawSecrets: NEW_SECRET,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyStorageReadCapability({
        ...verificationInput(newUrl),
        rawSecrets: OLD_SECRET,
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("fails safely when secrets are missing, empty, or shorter than 32 UTF-8 bytes", async () => {
    const baseInput = {
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    };

    for (const rawSecrets of [undefined, "", "   "]) {
      await expect(
        mintStorageReadCapabilityUrl({ ...baseInput, rawSecrets }),
      ).rejects.toMatchObject({
        name: "StorageReadCapabilityConfigurationError",
        code: "missing_secrets",
      });
    }
    await expect(
      mintStorageReadCapabilityUrl({
        ...baseInput,
        rawSecrets: `${NEW_SECRET},too-short`,
      }),
    ).rejects.toMatchObject({
      name: "StorageReadCapabilityConfigurationError",
      code: "secret_too_short",
    });
  });

  test("measures the minimum secret length in UTF-8 bytes", async () => {
    const exactly32Utf8Bytes = "é".repeat(16);
    const url = await mintStorageReadCapabilityUrl({
      rawSecrets: exactly32Utf8Bytes,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 60,
    });

    await expect(
      verifyStorageReadCapability({
        ...verificationInput(url),
        rawSecrets: exactly32Utf8Bytes,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test("rejects expired, future-issued, and overlong capabilities", async () => {
    const expiredUrl = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW - 120,
      expiresAt: NOW - 60,
    });
    await expect(
      verifyStorageReadCapability(verificationInput(expiredUrl)),
    ).resolves.toEqual({ ok: false, reason: "expired" });

    const futureUrl = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW + 1,
      expiresAt: NOW + 61,
    });
    await expect(
      verifyStorageReadCapability(verificationInput(futureUrl)),
    ).resolves.toEqual({ ok: false, reason: "not_yet_valid" });

    await expect(
      mintStorageReadCapabilityUrl({
        rawSecrets: NEW_SECRET,
        host: HOST,
        scopedKey: SCOPED_KEY,
        issuedAt: NOW,
        expiresAt: NOW + 3601,
      }),
    ).rejects.toBeInstanceOf(StorageReadCapabilityConfigurationError);

    const overlongUrl = await signedTestUrl({
      v: 1,
      p: "storage-read",
      h: HOST,
      m: "GET",
      k: SCOPED_KEY,
      iat: NOW,
      exp: NOW + 3601,
    });
    await expect(
      verifyStorageReadCapability(verificationInput(overlongUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_claims" });
  });

  test("rejects signature, host, method, key, and purpose substitution", async () => {
    const url = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });
    const { claims, payload, signature } = decodeWireClaims(url);

    const signatureSubstitution = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    const signatureUrl = `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.${payload}.${signatureSubstitution}`;
    await expect(
      verifyStorageReadCapability(verificationInput(signatureUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_signature" });

    const hostUrl = new URL(url);
    hostUrl.hostname = "other.example.test";
    await expect(
      verifyStorageReadCapability(verificationInput(hostUrl.toString())),
    ).resolves.toEqual({ ok: false, reason: "host_mismatch" });

    await expect(
      verifyStorageReadCapability(verificationInput(url, { method: "POST" })),
    ).resolves.toEqual({ ok: false, reason: "method_not_allowed" });

    const substitutedKeyPayload = base64Url(
      new TextEncoder().encode(
        JSON.stringify({ ...claims, k: "org/another-tenant/private.bin" }),
      ),
    );
    const keyUrl = `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.${substitutedKeyPayload}.${signature}`;
    await expect(
      verifyStorageReadCapability(verificationInput(keyUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_signature" });

    const substitutedPurposePayload = base64Url(
      new TextEncoder().encode(JSON.stringify({ ...claims, p: "other-use" })),
    );
    const purposeUrl = `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.${substitutedPurposePayload}.${signature}`;
    await expect(
      verifyStorageReadCapability(verificationInput(purposeUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("rejects even correctly signed claims with another purpose or unsafe key", async () => {
    const wrongPurposeUrl = await signedTestUrl({
      v: 1,
      p: "another-purpose",
      h: HOST,
      m: "GET",
      k: SCOPED_KEY,
      iat: NOW,
      exp: NOW + 600,
    });
    await expect(
      verifyStorageReadCapability(verificationInput(wrongPurposeUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_claims" });

    const unsafeKeyUrl = await signedTestUrl({
      v: 1,
      p: "storage-read",
      h: HOST,
      m: "GET",
      k: "org/tenant/../private.bin",
      iat: NOW,
      exp: NOW + 600,
    });
    await expect(
      verifyStorageReadCapability(verificationInput(unsafeKeyUrl)),
    ).resolves.toEqual({ ok: false, reason: "invalid_claims" });
  });

  test("returns typed failures for malformed and oversized attacker tokens", async () => {
    const malformedUrls = [
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}`,
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v2.a.b`,
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.not+url.safe`,
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}${"a".repeat(4097)}`,
      `https://${HOST}${STORAGE_READ_CAPABILITY_PATH_PREFIX}v1.a.${"a".repeat(43)}/extra`,
    ];

    for (const url of malformedUrls) {
      await expect(
        verifyStorageReadCapability(verificationInput(url)),
      ).resolves.toEqual({ ok: false, reason: "malformed_token" });
    }

    const validUrl = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });
    const withQuery = new URL(validUrl);
    withQuery.search = "?download=1";
    await expect(
      verifyStorageReadCapability(verificationInput(withQuery.toString())),
    ).resolves.toEqual({ ok: false, reason: "invalid_url" });
    await expect(
      verifyStorageReadCapability(
        verificationInput(validUrl.replace("https:", "http:")),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid_url" });
  });

  test("rejects non-tenant-scoped signer input and an invalid supplied clock", async () => {
    await expect(
      mintStorageReadCapabilityUrl({
        rawSecrets: NEW_SECRET,
        host: HOST,
        scopedKey: "avatars/public.png",
        issuedAt: NOW,
        expiresAt: NOW + 600,
      }),
    ).rejects.toMatchObject({ code: "invalid_scoped_key" });

    const url = await mintStorageReadCapabilityUrl({
      rawSecrets: NEW_SECRET,
      host: HOST,
      scopedKey: SCOPED_KEY,
      issuedAt: NOW,
      expiresAt: NOW + 600,
    });
    await expect(
      verifyStorageReadCapability({
        ...verificationInput(url),
        now: Number.NaN,
      }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
  });
});
