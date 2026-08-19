/**
 * Exercises the real storage presign route and proves it settles one durable
 * server-priced receipt before minting an opaque native read capability.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ROUTE_PATH = "/api/v1/apis/storage/presign";
const ORG = "00000000-0000-4000-8000-000000021009";
const USER = "00000000-0000-4000-8000-000000021010";
const CAPABILITY = "00000000-0000-4000-8000-000000021011";
const RECEIPT = "00000000-0000-4000-8000-000000021012";
const ISSUED = new Date(Date.now() - 1_000);
const EXPIRES = new Date(Date.now() + 5 * 60_000);

const requireUserOrApiKeyWithOrg = mock();
const executeNativeStoragePresign = mock();
const getServiceMethodCost = mock();
const mintStorageReadCapabilityUrl = mock();

class TestNativeStorageReadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
class TestStorageReadCapabilityConfigurationError extends Error {
  readonly code = "CONFIGURATION";
}

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/storage/native-storage-read", () => ({
  executeNativeStoragePresign,
  NativeStorageReadError: TestNativeStorageReadError,
}));
mock.module("@/lib/services/proxy/pricing", () => ({ getServiceMethodCost }));
mock.module("@/api-app/storage-read-capability", () => ({
  mintStorageReadCapabilityUrl,
  validateStorageReadCapabilityConfiguration: (
    secrets: string | undefined,
    value: string,
  ) => {
    if (!secrets) throw new TestStorageReadCapabilityConfigurationError();
    return new URL(value).host;
  },
  StorageReadCapabilityConfigurationError:
    TestStorageReadCapabilityConfigurationError,
}));

const presignRoute = (await import("../v1/apis/storage/presign/route")).default;
const app = new Hono();
app.route(ROUTE_PATH, presignRoute);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  executeNativeStoragePresign.mockReset();
  getServiceMethodCost.mockReset();
  mintStorageReadCapabilityUrl.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER,
    organization_id: ORG,
  });
  getServiceMethodCost.mockResolvedValue(0.0002);
  executeNativeStoragePresign.mockResolvedValue({
    operation: {
      id: RECEIPT,
      capability_id: CAPABILITY,
      capability_issued_at: ISSUED,
      capability_expires_at: EXPIRES,
    },
    status: 200,
    body: { receiptId: RECEIPT, expiresAt: EXPIRES.toISOString() },
    replay: false,
  });
  mintStorageReadCapabilityUrl.mockResolvedValue(
    `https://blob.example/__eliza_storage_capability/v1/${CAPABILITY}.sig`,
  );
});

test("settles the exact server quote before minting an opaque capability", async () => {
  const bucket = { head: mock() };
  const response = await app.request(
    ROUTE_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "presign-1",
        "X-Storage-Object-Key": "private/voice.ogg",
      },
      body: JSON.stringify({
        operation: "get",
        expiresIn: 300,
      }),
    },
    {
      BLOB: bucket,
      R2_PUBLIC_HOST: "https://blob.example",
      STORAGE_READ_SIGNING_SECRETS: "active-secret-that-is-long-enough",
    },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { url: string; receiptId: string };
  expect(body.receiptId).toBe(RECEIPT);
  expect(body.url).not.toContain("private");
  expect(body.url).not.toContain("voice");
  expect(executeNativeStoragePresign).toHaveBeenCalledWith({
    bucket,
    organizationId: ORG,
    userId: USER,
    logicalKey: "private/voice.ogg",
    rawIdempotencyKey: "presign-1",
    priceUsd: 0.0002,
    capabilityHost: "blob.example",
    ttlSeconds: 300,
  });
  expect(mintStorageReadCapabilityUrl).toHaveBeenCalledTimes(1);
});

test("malformed requests stop before pricing, provider, or receipt authority", async () => {
  const response = await app.request(
    ROUTE_PATH,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    },
    { BLOB: { head: mock() }, R2_PUBLIC_HOST: "https://blob.example" },
  );
  expect(response.status).toBe(400);
  expect(getServiceMethodCost).not.toHaveBeenCalled();
  expect(executeNativeStoragePresign).not.toHaveBeenCalled();
  expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
});

test("missing signer authority stops before pricing, provider, or settlement", async () => {
  const response = await app.request(
    ROUTE_PATH,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "presign-no-signer",
        "X-Storage-Object-Key": "private/voice.ogg",
      },
      body: JSON.stringify({ operation: "get" }),
    },
    { BLOB: { head: mock() }, R2_PUBLIC_HOST: "https://blob.example" },
  );
  expect(response.status).toBe(503);
  expect(getServiceMethodCost).not.toHaveBeenCalled();
  expect(executeNativeStoragePresign).not.toHaveBeenCalled();
  expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
});
