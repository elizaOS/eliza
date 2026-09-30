import { afterAll, expect, mock, test } from "bun:test";
import type { Context } from "hono";

const effects: Array<{ kind: string; priceUsd: number }> = [];
let servicePricingReads = 0;
mock.module("@/api-app/lib/paid-route-standing", () => ({
  requirePaidRouteStanding: async () => ({
    user: { id: "user", organization_id: "org" },
  }),
}));
mock.module("@/db/repositories", () => ({
  StoragePutConflictError: class extends Error {},
  StorageQuotaExceededError: class extends Error {},
  servicePricingRepository: {
    listByService: async () => {
      servicePricingReads += 1;
      return [];
    },
  },
}));
mock.module("@/lib/cache/client", () => ({
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error() {}, warn() {}, info() {} },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: Context) => c.json({ error: "unexpected" }, 500),
}));
mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class extends Error {},
}));
const effect = (kind: string) => async (args: { priceUsd: number }) => {
  effects.push({ kind, priceUsd: args.priceUsd });
  return {
    status: 200,
    operation: {
      id: "receipt",
      capability_id: "cap",
      capability_issued_at: new Date(),
      capability_expires_at: new Date(Date.now() + 60_000),
    },
    body: { items: [] },
    headers: {
      contentType: "text/plain",
      size: 3,
      etag: "etag",
      lastModified: new Date(0).toUTCString(),
    },
    stream: new ReadableStream(),
  };
};
const putPriceInputs: Array<[number, number, number]> = [];
mock.module("@/lib/services/storage/native-storage-put", () => ({
  NativeStoragePutError: class extends Error {},
  resolveNativeStorageObject: async () => ({
    provider_key: "immutable-generation",
  }),
  calculateStoragePutPrice: (flat: number, perByte: number, bytes: number) => {
    putPriceInputs.push([flat, perByte, bytes]);
    return flat + perByte * bytes;
  },
  executeNativeStoragePut: effect("put"),
  executeNativeStorageDelete: effect("delete"),
}));
mock.module("@/lib/services/storage/native-storage-read", () => ({
  NativeStorageReadError: class extends Error {},
  executeNativeStorageList: effect("list"),
  executeNativeStorageGetOrHead: effect("read"),
  executeNativeStoragePresign: effect("presign"),
}));
mock.module("@/api-app/storage-read-capability", () => ({
  StorageReadCapabilityConfigurationError: class extends Error {},
  validateStorageReadCapabilityConfiguration: () => "https://storage.example",
  mintStorageReadCapabilityUrl: async () => "https://storage.example/cap",
}));
const { default: objects } = await import(
  "../v1/apis/storage/objects/[...key]/route"
);
const { default: list } = await import("../v1/apis/storage/list/route");
const { default: presign } = await import("../v1/apis/storage/presign/route");
const { STORAGE_PRICING, STORAGE_PRICED_OPERATIONS, storageOperationPriceUsd } =
  await import("@/lib/constants/pricing");
const env = {
  BLOB: {
    put: async () => ({}),
    get: async () => null,
    head: async () => null,
    list: async () => ({ objects: [] }),
    delete: async () => {},
  },
  R2_PUBLIC_HOST: "https://storage.example",
  STORAGE_READ_SIGNING_SECRETS: "fixture",
};
const headers = {
  "X-Storage-Object-Key": "document",
  "X-Content-Length": "3",
  "X-Content-SHA256": "a".repeat(64),
  "Idempotency-Key": "test-operation",
};
afterAll(() => mock.restore());

test("the ratified storage catalogue is pinned exactly (#22956)", () => {
  expect(STORAGE_PRICING).toEqual({
    put: "0.0001",
    put_per_byte: "0.000000001",
    get: "0.00005",
    head: "0.00005",
    list: "0.00005",
    presign: "0.00005",
    delete: "0",
  });
  expect(Object.isFrozen(STORAGE_PRICING)).toBe(true);
  expect([...STORAGE_PRICED_OPERATIONS].sort() as string[]).toEqual(
    ["delete", "get", "head", "list", "presign", "put", "put_per_byte"].sort(),
  );
  for (const operation of STORAGE_PRICED_OPERATIONS) {
    expect(storageOperationPriceUsd(operation)).toBe(
      Number(STORAGE_PRICING[operation]),
    );
  }
});

test("every storage route charges the catalogue price without a DB pricing read", async () => {
  effects.length = 0;
  putPriceInputs.length = 0;
  servicePricingReads = 0;
  const put = await objects.request(
    "/_",
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: "abc",
    },
    env,
  );
  expect(put.status).toBe(201);
  await objects.request("/_", { method: "GET", headers }, env);
  await objects.request("/_", { method: "HEAD", headers }, env);
  expect(
    (await objects.request("/_", { method: "DELETE", headers }, env)).status,
  ).toBe(204);
  expect((await list.request("/", { headers }, env)).status).toBe(200);
  await presign.request(
    "/",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "get" }),
    },
    env,
  );
  expect(effects).toEqual([
    { kind: "put", priceUsd: 0.0001 + 0.000000001 * 3 },
    { kind: "read", priceUsd: 0.00005 },
    { kind: "read", priceUsd: 0.00005 },
    { kind: "delete", priceUsd: 0 },
    { kind: "list", priceUsd: 0.00005 },
    { kind: "presign", priceUsd: 0.00005 },
  ]);
  expect(putPriceInputs).toEqual([[0.0001, 0.000000001, 3]]);
  expect(servicePricingReads).toBe(0);
});
