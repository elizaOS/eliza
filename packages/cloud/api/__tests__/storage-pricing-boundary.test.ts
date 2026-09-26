import { afterAll, expect, mock, test } from "bun:test";
import type { Context } from "hono";

let prices: Record<string, string> = {};
const effects: Array<{ kind: string; priceUsd: number }> = [];
const methods = [
  "put",
  "put_per_byte",
  "get",
  "head",
  "delete",
  "list",
  "presign",
];
mock.module("@/api-app/lib/paid-route-standing", () => ({
  requirePaidRouteStanding: async () => ({
    user: { id: "user", organization_id: "org" },
  }),
}));
mock.module("@/db/repositories", () => ({
  StoragePutConflictError: class extends Error {},
  StorageQuotaExceededError: class extends Error {},
  servicePricingRepository: {
    listByService: async () =>
      Object.entries(prices).map(([method, cost]) => ({ method, cost })),
  },
}));
mock.module("@/lib/cache/client", () => ({
  cache: { get: async () => null, set: async () => {}, del: async () => {} },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { error() {}, warn() {}, info() {} },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: Context) => c.json({ error: "invalid pricing" }, 500),
}));
mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError: class extends Error {},
}));
const effect = (kind: string) => async (args: { priceUsd: number }) => {
  effects.push({ kind, priceUsd: args.priceUsd });
  return { operation: { id: "receipt" }, body: { items: [] } };
};
mock.module("@/lib/services/storage/native-storage-put", () => ({
  NativeStoragePutError: class extends Error {},
  resolveNativeStorageObject: async () => ({
    provider_key: "immutable-generation",
  }),
  calculateStoragePutPrice: () => {
    throw new Error("Missing PUT prices must fail before arithmetic");
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
  mintStorageReadCapabilityUrl: () => {
    throw new Error("No capability without a price");
  },
}));
const { default: objects } = await import(
  "../v1/apis/storage/objects/[...key]/route"
);
const { default: list } = await import("../v1/apis/storage/list/route");
const { default: presign } = await import("../v1/apis/storage/presign/route");
const { requireServiceMethodCost } = await import(
  "@/lib/services/proxy/pricing"
);
const noProvider = () => {
  throw new Error("Provider must not run before pricing");
};
const env = {
  BLOB: {
    put: noProvider,
    get: noProvider,
    head: noProvider,
    list: noProvider,
    delete: noProvider,
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
const cases = [
  { method: "PUT", price: "put" },
  { method: "PUT", price: "put_per_byte" },
  { method: "GET", price: "get" },
  { method: "HEAD", price: "head" },
  { method: "DELETE", price: "delete" },
  { method: "GET", price: "list" },
  { method: "POST", price: "presign" },
];
afterAll(() => mock.restore());

test("all seven required storage prices fail before provider or billing effects", async () => {
  for (const item of cases) {
    for (const empty of [true, false]) {
      prices = empty
        ? {}
        : Object.fromEntries(
            methods.filter((m) => m !== item.price).map((m) => [m, "0.000001"]),
          );
      const app =
        item.price === "list"
          ? list
          : item.price === "presign"
            ? presign
            : objects;
      const response = await app.request(
        item.price === "list" || item.price === "presign" ? "/" : "/_",
        {
          method: item.method,
          headers: { ...headers, "Content-Type": "application/json" },
          ...(item.method === "PUT"
            ? { body: "abc" }
            : item.method === "POST"
              ? { body: JSON.stringify({ operation: "get" }) }
              : {}),
        },
        env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(effects).toEqual([]);
    }
  }
});

test("catalog recovery preserves decimal and configured zero prices", async () => {
  prices = { list: "0.000000001", delete: "0.000000000000" };
  expect((await list.request("/", { headers }, env)).status).toBe(200);
  expect(
    (await objects.request("/_", { method: "DELETE", headers }, env)).status,
  ).toBe(204);
  expect(effects).toEqual([
    { kind: "list", priceUsd: 1e-9 },
    { kind: "delete", priceUsd: 0 },
  ]);
  for (const value of ["-1", "NaN", "Infinity", "1oops", "0x10", " "]) {
    prices = { put_per_byte: value };
    await expect(
      requireServiceMethodCost("storage", "put_per_byte"),
    ).rejects.toMatchObject({ code: "INVALID_SERVICE_PRICING" });
  }
});
