/**
 * Adversarially exercises the Workers-native capability signer without mocks,
 * including rotation, tampering, host/method binding, expiry, and URL privacy.
 */

import { describe, expect, test } from "bun:test";
import {
  mintStorageReadCapabilityUrl,
  StorageReadCapabilityConfigurationError,
  verifyStorageReadCapability,
} from "./storage-read-capability";

const ACTIVE = "active-storage-read-secret-material-0001";
const PREVIOUS = "previous-storage-read-secret-material-01";
const CAPABILITY = "00000000-0000-4000-8000-000000021011";
const NOW = 1_787_137_200;

async function mint(secret = ACTIVE): Promise<URL> {
  return new URL(
    await mintStorageReadCapabilityUrl({
      rawSecrets: secret,
      host: "blob.example",
      capabilityId: CAPABILITY,
      issuedAt: NOW,
      expiresAt: NOW + 300,
    }),
  );
}

describe("storage read capability", () => {
  test("contains no tenant, logical key, or provider key and verifies exact claims", async () => {
    const url = await mint();
    expect(url.href).not.toContain("organization");
    expect(url.href).not.toContain("private%2Fvoice");
    expect(url.search).toBe("");
    await expect(
      verifyStorageReadCapability({
        rawSecrets: ACTIVE,
        url,
        method: "GET",
        now: NOW + 1,
      }),
    ).resolves.toEqual({
      ok: true,
      claims: {
        version: 2,
        purpose: "storage-read",
        host: "blob.example",
        capabilityId: CAPABILITY,
        issuedAt: NOW,
        expiresAt: NOW + 300,
      },
    });
  });

  test("accepts a previous rotation secret but only signs with the active secret", async () => {
    const oldUrl = await mint(PREVIOUS);
    expect(
      await verifyStorageReadCapability({
        rawSecrets: `${ACTIVE},${PREVIOUS}`,
        url: oldUrl,
        method: "HEAD",
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: true });
    const newUrl = await mint(`${ACTIVE},${PREVIOUS}`);
    expect(
      await verifyStorageReadCapability({
        rawSecrets: ACTIVE,
        url: newUrl,
        method: "GET",
        now: NOW + 1,
      }),
    ).toMatchObject({ ok: true });
  });

  test("rejects tamper, wrong host, wrong method, not-yet-valid, and expiry", async () => {
    const url = await mint();
    const tampered = new URL(url);
    tampered.pathname = `${tampered.pathname.slice(0, -1)}A`;
    for (const input of [
      { url: tampered, method: "GET", now: NOW + 1 },
      {
        url: new URL(url.href.replace("blob.example", "other.example")),
        method: "GET",
        now: NOW + 1,
      },
      { url, method: "POST", now: NOW + 1 },
      { url, method: "GET", now: NOW - 1 },
      { url, method: "GET", now: NOW + 300 },
    ]) {
      expect(
        await verifyStorageReadCapability({ rawSecrets: ACTIVE, ...input }),
      ).toEqual({
        ok: false,
      });
    }
  });

  test("fails closed for missing or undersized signer configuration", async () => {
    await expect(
      mintStorageReadCapabilityUrl({
        rawSecrets: undefined,
        host: "blob.example",
        capabilityId: CAPABILITY,
        issuedAt: NOW,
        expiresAt: NOW + 300,
      }),
    ).rejects.toBeInstanceOf(StorageReadCapabilityConfigurationError);
    await expect(
      mintStorageReadCapabilityUrl({
        rawSecrets: "short",
        host: "blob.example",
        capabilityId: CAPABILITY,
        issuedAt: NOW,
        expiresAt: NOW + 300,
      }),
    ).rejects.toBeInstanceOf(StorageReadCapabilityConfigurationError);
  });
});
