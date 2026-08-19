/**
 * Exercises opaque capability delivery through the real blob-host handler with
 * deterministic database authorization and a fake exact-generation R2 binding.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const authorizeNativeStorageCapability = mock();
mock.module("@/lib/runtime/cloud-bindings", () => ({
  runWithCloudBindingsAsync: async (
    _env: unknown,
    callback: () => Promise<unknown>,
  ) => await callback(),
}));
mock.module("@/db/client", () => ({
  runWithDbCacheAsync: async (callback: () => Promise<unknown>) =>
    await callback(),
}));
mock.module("@/lib/services/storage/native-storage-read", () => ({
  authorizeNativeStorageCapability,
}));

const { serveBlobHostRequest } = await import("./blob-host");
const { mintStorageReadCapabilityUrl } = await import(
  "./storage-read-capability"
);

const SECRET = "active-storage-read-secret-material-0001";
const CAPABILITY = "00000000-0000-4000-8000-000000021011";
const PROVIDER_KEY = "__eliza_storage_authority/v2/opaque-generation";

beforeEach(() => {
  authorizeNativeStorageCapability.mockReset();
});

async function capabilityUrl(): Promise<{ url: string; issuedAt: number }> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const url = await mintStorageReadCapabilityUrl({
    rawSecrets: SECRET,
    host: "blob.example",
    capabilityId: CAPABILITY,
    issuedAt,
    expiresAt: issuedAt + 300,
  });
  return { url, issuedAt };
}

test("resolves an opaque capability to one exact provider generation", async () => {
  const { url, issuedAt } = await capabilityUrl();
  const parsed = new URL(url);
  authorizeNativeStorageCapability.mockResolvedValue({
    provider_key: PROVIDER_KEY,
    result_size_bytes: 5n,
    result_etag: "etag-1",
    result_content_type: "audio/ogg",
    capability_issued_at: new Date(issuedAt * 1000),
    capability_expires_at: new Date((issuedAt + 300) * 1000),
  });
  const bytes = new TextEncoder().encode("asset");
  const get = mock(async () => ({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    size: 5,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    text: async () => "asset",
    arrayBuffer: async () => bytes.buffer,
  }));
  const response = await serveBlobHostRequest(new Request(url), parsed, {
    BLOB: { get, put: mock(), delete: mock() },
    R2_PUBLIC_HOST: "blob.example",
    STORAGE_READ_SIGNING_SECRETS: SECRET,
  });
  expect(response?.status).toBe(200);
  expect(await response?.text()).toBe("asset");
  expect(response?.headers.get("cache-control")).toBe("private, no-store");
  expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  expect(get).toHaveBeenCalledWith(PROVIDER_KEY, {
    onlyIf: { etagMatches: "etag-1" },
  });
  expect(authorizeNativeStorageCapability).toHaveBeenCalledWith({
    capabilityId: CAPABILITY,
    capabilityHost: "blob.example",
    now: expect.any(Date),
  });
});

test("fails closed before R2 when the durable receipt is revoked or missing", async () => {
  authorizeNativeStorageCapability.mockResolvedValue(undefined);
  const get = mock();
  const { url } = await capabilityUrl();
  const response = await serveBlobHostRequest(new Request(url), new URL(url), {
    BLOB: { get, put: mock(), delete: mock() },
    R2_PUBLIC_HOST: "blob.example",
    STORAGE_READ_SIGNING_SECRETS: SECRET,
  });
  expect(response?.status).toBe(404);
  expect(response?.headers.get("cache-control")).toBe("private, no-store");
  expect(get).not.toHaveBeenCalled();
});
