/**
 * Exercises the real storage object Hono router to protect HEAD from Hono's
 * automatic HEAD-to-GET dispatch. The suite proves metadata requests never
 * enter the object-body path and catalog reads remain explicitly unbilled.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021045";
const ROUTE_PREFIX = "/api/v1/apis/storage/objects";
const ROUTE_MOUNT = `${ROUTE_PREFIX}/:*{.+}`;
const OBJECT_PATH = "voice/message.ogg";
const GET_COST = 0.00011;
const OBJECT_BYTES = new TextEncoder().encode("asset");
const MODIFIED_AT = new Date("2026-08-17T12:00:00.000Z");

const requireUserOrApiKeyWithOrg = mock();
const getServiceMethodCost = mock();
const deductCredits = mock();
const tryReserveBytes = mock();
const releaseBytes = mock();
const resolveNativeStorageObject = mock();
const executeNativeStoragePut = mock();
const executeNativeStorageDelete = mock();
const executeNativeStorageGetOrHead = mock();
const loggerError = mock();
const failureResponse = mock((_context: unknown, error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : "Unexpected test error" },
    { status: 500 },
  ),
);
class TestStoragePutConflictError extends Error {}
class TestStorageQuotaExceededError extends Error {}
class TestInsufficientCreditsError extends Error {}
class TestNativeStoragePutError extends Error {}

mock.module("@/db/repositories", () => ({
  StoragePutConflictError: TestStoragePutConflictError,
  StorageQuotaExceededError: TestStorageQuotaExceededError,
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits },
  InsufficientCreditsError: TestInsufficientCreditsError,
}));

mock.module("@/lib/services/storage/native-storage-put", () => ({
  calculateStoragePutPrice: (flat: number, perByte: number, bytes: number) =>
    Number((flat + perByte * bytes).toFixed(6)),
  executeNativeStoragePut,
  executeNativeStorageDelete,
  resolveNativeStorageObject,
  NativeStoragePutError: TestNativeStoragePutError,
}));

class TestNativeStorageReadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
mock.module("@/lib/services/storage/native-storage-read", () => ({
  executeNativeStorageGetOrHead,
  NativeStorageReadError: TestNativeStorageReadError,
}));

mock.module("@/lib/services/proxy/pricing", () => ({
  getServiceMethodCost,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const storageObjectsRoute = (
  await import("../v1/apis/storage/objects/[...key]/route")
).default;
const app = new Hono();
app.route(ROUTE_MOUNT, storageObjectsRoute);

const nativeObject = {
  generation: 1n,
  provider_key: `__eliza_storage_authority/v2/org/${ORGANIZATION_ID}/object/1`,
  size_bytes: BigInt(OBJECT_BYTES.byteLength),
  content_type: "audio/ogg",
  etag: "storage-etag",
  uploaded_at: MODIFIED_AT,
  deleted_at: null,
};
const bucket = {
  get: mock(async () => ({
    body: OBJECT_BYTES,
    arrayBuffer: async () => OBJECT_BYTES.buffer,
  })),
  head: mock(async () => ({
    size: OBJECT_BYTES.byteLength,
    etag: "storage-etag",
  })),
  put: mock(),
  delete: mock(),
};
function request(method: "GET" | "HEAD"): Response | Promise<Response> {
  return app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method,
      headers: {
        "X-Storage-Object-Key": OBJECT_PATH,
        "Idempotency-Key": `${method.toLowerCase()}-1`,
      },
    },
    { BLOB: bucket },
  );
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getServiceMethodCost.mockReset();
  deductCredits.mockReset();
  tryReserveBytes.mockReset();
  releaseBytes.mockReset();
  resolveNativeStorageObject.mockReset();
  executeNativeStoragePut.mockReset();
  executeNativeStorageDelete.mockReset();
  executeNativeStorageGetOrHead.mockReset();
  loggerError.mockReset();
  failureResponse.mockClear();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
    id: "00000000-0000-4000-8000-000000021046",
  });
  deductCredits.mockResolvedValue({ success: true });
  getServiceMethodCost.mockResolvedValue(GET_COST);
  resolveNativeStorageObject.mockResolvedValue(nativeObject);
  executeNativeStorageGetOrHead.mockImplementation(
    async ({ method }: { method: string }) => ({
      operation: { id: `receipt-${method}` },
      status: 200,
      headers: {
        contentType: "audio/ogg",
        size: OBJECT_BYTES.byteLength,
        etag: "storage-etag",
        lastModified: MODIFIED_AT.toUTCString(),
      },
      object:
        method === "get"
          ? { body: OBJECT_BYTES, arrayBuffer: async () => OBJECT_BYTES.buffer }
          : undefined,
      replay: false,
    }),
  );
});

test("PUT uses the authenticated native BLOB path with server-owned pricing", async () => {
  const bucket = { head: mock(), get: mock(), put: mock(), delete: mock() };
  getServiceMethodCost.mockResolvedValueOnce(0.25).mockResolvedValueOnce(0.01);
  executeNativeStoragePut.mockResolvedValue({
    key: OBJECT_PATH,
    size: OBJECT_BYTES.byteLength,
    contentType: "audio/ogg",
    etag: "native-etag",
  });

  const response = await app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method: "PUT",
      headers: {
        "content-type": "audio/ogg",
        "idempotency-key": "logical-upload-1",
        "X-Storage-Object-Key": OBJECT_PATH,
      },
      body: OBJECT_BYTES,
    },
    { BLOB: bucket },
  );

  expect(response.status).toBe(201);
  expect(executeNativeStoragePut).toHaveBeenCalledTimes(1);
  expect(executeNativeStoragePut).toHaveBeenCalledWith({
    bucket,
    organizationId: ORGANIZATION_ID,
    logicalKey: OBJECT_PATH,
    idempotencyKey: "logical-upload-1",
    body: expect.any(ArrayBuffer),
    contentType: "audio/ogg",
    priceUsd: 0.3,
  });
  expect(tryReserveBytes).not.toHaveBeenCalled();
  expect(deductCredits).not.toHaveBeenCalled();
});

test("routes PUT through GET and HEAD, overwrite, then durable native DELETE", async () => {
  const uploadedAt = new Date("2026-08-18T19:00:00.000Z");
  const providerKey = `__eliza_storage_authority/v2/org/${ORGANIZATION_ID}/object/1`;
  resolveNativeStorageObject.mockResolvedValue({
    generation: 1n,
    provider_key: providerKey,
    size_bytes: BigInt(OBJECT_BYTES.byteLength),
    content_type: "audio/ogg",
    etag: "native-etag",
    uploaded_at: uploadedAt,
    deleted_at: null,
  });
  getServiceMethodCost.mockResolvedValue(GET_COST);
  const bucket = {
    get: mock(async () => ({
      text: async () => "asset",
      arrayBuffer: async () => OBJECT_BYTES.buffer,
    })),
    head: mock(async () => ({
      size: OBJECT_BYTES.byteLength,
      etag: "native-etag",
      uploaded: uploadedAt,
    })),
    put: mock(),
    delete: mock(),
  };

  const getResponse = await app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method: "GET",
      headers: {
        "X-Storage-Object-Key": OBJECT_PATH,
        "Idempotency-Key": "combined-get",
      },
    },
    { BLOB: bucket },
  );
  expect(getResponse.status).toBe(200);
  expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(OBJECT_BYTES);

  const headResponse = await app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method: "HEAD",
      headers: {
        "X-Storage-Object-Key": OBJECT_PATH,
        "Idempotency-Key": "combined-head",
      },
    },
    { BLOB: bucket },
  );
  expect(headResponse.status).toBe(200);
  expect(headResponse.headers.get("etag")).toBe("storage-etag");

  executeNativeStoragePut.mockResolvedValue({
    key: OBJECT_PATH,
    size: OBJECT_BYTES.byteLength,
    contentType: "audio/ogg",
    etag: "native-etag-2",
  });
  const overwriteResponse = await app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method: "PUT",
      headers: {
        "content-type": "audio/ogg",
        "idempotency-key": "overwrite-2",
        "X-Storage-Object-Key": OBJECT_PATH,
      },
      body: OBJECT_BYTES,
    },
    { BLOB: bucket },
  );
  expect(overwriteResponse.status).toBe(201);

  executeNativeStorageDelete.mockResolvedValue(undefined);
  getServiceMethodCost.mockResolvedValueOnce(0);

  const deleteResponse = await app.request(
    `${ROUTE_PREFIX}/_`,
    {
      method: "DELETE",
      headers: {
        "idempotency-key": "delete-1",
        "X-Storage-Object-Key": OBJECT_PATH,
      },
    },
    { BLOB: bucket },
  );
  expect(deleteResponse.status).toBe(204);
  expect(executeNativeStorageDelete).toHaveBeenCalledWith({
    bucket,
    organizationId: ORGANIZATION_ID,
    logicalKey: OBJECT_PATH,
    idempotencyKey: "delete-1",
    priceUsd: 0,
  });
  expect(bucket.delete).not.toHaveBeenCalled();
});

describe("storage object HEAD routing", () => {
  test("does not place logical keys or sensitive headers in API logs", async () => {
    const response = await app.request(
      `${ROUTE_PREFIX}/_`,
      {
        method: "PUT",
        headers: {
          "X-Storage-Object-Key": "private/do-not-log.ogg",
          "Idempotency-Key": "private-idempotency-key",
          Authorization: "Bearer private-token",
        },
        body: "private-object-bytes",
      },
      {},
    );
    expect(response.status).toBe(503);
    expect(loggerError).toHaveBeenCalled();
    const capturedLogs = JSON.stringify(loggerError.mock.calls);
    expect(capturedLogs).not.toContain("do-not-log");
    expect(capturedLogs).not.toContain("private-idempotency-key");
    expect(capturedLogs).not.toContain("private-token");
    expect(capturedLogs).not.toContain("Authorization");
  });

  test("rejects logical object keys in read URLs before pricing or provider authority", async () => {
    const response = await app.request(
      `${ROUTE_PREFIX}/${OBJECT_PATH}`,
      {
        method: "GET",
        headers: {
          "X-Storage-Object-Key": OBJECT_PATH,
          "Idempotency-Key": "legacy-url",
        },
      },
      { BLOB: bucket },
    );
    expect(response.status).toBe(400);
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(executeNativeStorageGetOrHead).not.toHaveBeenCalled();
  });

  test("does not charge failed native or legacy reads", async () => {
    executeNativeStorageGetOrHead.mockRejectedValueOnce(
      new TestNativeStorageReadError(
        "PROVIDER_INTEGRITY",
        "missing generation",
      ),
    );
    const native = await app.request(
      `${ROUTE_PREFIX}/_`,
      {
        method: "GET",
        headers: {
          "X-Storage-Object-Key": OBJECT_PATH,
          "Idempotency-Key": "missing-native",
        },
      },
      {
        BLOB: {
          get: mock(async () => null),
          head: mock(),
          put: mock(),
          delete: mock(),
        },
      },
    );
    expect(native.status).toBe(503);
    expect(deductCredits).not.toHaveBeenCalled();

    executeNativeStorageGetOrHead.mockResolvedValueOnce({
      operation: { id: "receipt-missing" },
      status: 404,
      replay: false,
    });
    const legacy = await request("GET");
    expect(legacy.status).toBe(404);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("serves HEAD metadata through one durable priced receipt", async () => {
    const response = await request("HEAD");

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(response.headers.get("content-type")).toBe("audio/ogg");
    expect(response.headers.get("content-length")).toBe(
      String(OBJECT_BYTES.byteLength),
    );
    expect(response.headers.get("etag")).toBe("storage-etag");
    expect(response.headers.get("last-modified")).toBe(
      MODIFIED_AT.toUTCString(),
    );

    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "head");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(executeNativeStorageGetOrHead).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "head",
        logicalKey: OBJECT_PATH,
        priceUsd: GET_COST,
      }),
    );
    expect(tryReserveBytes).not.toHaveBeenCalled();
    expect(releaseBytes).not.toHaveBeenCalled();
    expect(failureResponse).not.toHaveBeenCalled();
  });

  test("serves the catalog GET body through one durable priced receipt", async () => {
    const response = await request("GET");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES);
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "get");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(executeNativeStorageGetOrHead).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "get",
        logicalKey: OBJECT_PATH,
        priceUsd: GET_COST,
      }),
    );
    expect(failureResponse).not.toHaveBeenCalled();
  });
});
