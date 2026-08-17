/**
 * Exercises the real storage object Hono router to protect HEAD from Hono's
 * automatic HEAD-to-GET dispatch. The suite proves metadata requests never
 * enter the object-body path or use GET pricing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021045";
const ROUTE_PREFIX = "/api/v1/apis/storage/objects";
const ROUTE_MOUNT = `${ROUTE_PREFIX}/:*{.+}`;
const OBJECT_PATH = "voice/message.ogg";
const SCOPED_KEY = `org/${ORGANIZATION_ID}/${OBJECT_PATH}`;
const HEAD_COST = 0.00007;
const GET_COST = 0.00011;
const OBJECT_BYTES = new TextEncoder().encode("asset");
const MODIFIED_AT = new Date("2026-08-17T12:00:00.000Z");

const requireUserOrApiKeyWithOrg = mock();
const getR2StorageAdapter = mock();
const getServiceMethodCost = mock();
const deductCredits = mock();
const exists = mock();
const read = mock();
const stat = mock();
const write = mock();
const remove = mock();
const tryReserveBytes = mock();
const releaseBytes = mock();
const loggerError = mock();
const failureResponse = mock((_context: unknown, error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : "Unexpected test error" },
    { status: 500 },
  ),
);

mock.module("@/db/repositories", () => ({
  orgStorageQuotaRepository: { tryReserveBytes, releaseBytes },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits },
}));

mock.module("@/lib/services/proxy/pricing", () => ({
  getServiceMethodCost,
}));

mock.module("@/lib/services/storage/r2-storage-adapter", () => ({
  getR2StorageAdapter,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const storageObjectsRoute = (
  await import("../v1/apis/storage/objects/[...key]/route")
).default;
const app = new Hono();
app.route(ROUTE_MOUNT, storageObjectsRoute);

function request(method: "GET" | "HEAD"): Response | Promise<Response> {
  return app.request(`${ROUTE_PREFIX}/${OBJECT_PATH}`, { method });
}

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  getR2StorageAdapter.mockReset();
  getServiceMethodCost.mockReset();
  deductCredits.mockReset();
  exists.mockReset();
  read.mockReset();
  stat.mockReset();
  write.mockReset();
  remove.mockReset();
  tryReserveBytes.mockReset();
  releaseBytes.mockReset();
  loggerError.mockReset();
  failureResponse.mockClear();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
  });
  getR2StorageAdapter.mockReturnValue({ exists, read, stat, write, remove });
  deductCredits.mockResolvedValue({ success: true });
  exists.mockResolvedValue(true);
  read.mockResolvedValue(OBJECT_BYTES);
  stat.mockResolvedValue({
    size: OBJECT_BYTES.byteLength,
    contentType: "audio/ogg",
    etag: "storage-etag",
    modified: MODIFIED_AT,
  });
});

describe("storage object HEAD routing", () => {
  test("uses HEAD pricing and metadata without reading the object body", async () => {
    getServiceMethodCost.mockResolvedValue(HEAD_COST);

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
    expect(getR2StorageAdapter).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "head");
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      amount: HEAD_COST,
      description: "API proxy: storage — head",
      metadata: {
        type: "proxy_storage",
        service: "storage",
        method: "head",
        key: OBJECT_PATH,
      },
    });
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(SCOPED_KEY);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(SCOPED_KEY);
    expect(read).not.toHaveBeenCalled();
    expect(tryReserveBytes).not.toHaveBeenCalled();
    expect(releaseBytes).not.toHaveBeenCalled();
    expect(failureResponse).not.toHaveBeenCalled();
  });

  test("preserves the existing GET pricing and body path", async () => {
    getServiceMethodCost.mockResolvedValue(GET_COST);

    const response = await request("GET");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(OBJECT_BYTES);
    expect(getServiceMethodCost).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "get");
    expect(deductCredits).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      amount: GET_COST,
      description: "API proxy: storage — get",
      metadata: {
        type: "proxy_storage",
        service: "storage",
        method: "get",
        key: OBJECT_PATH,
      },
    });
    expect(exists).toHaveBeenCalledWith(SCOPED_KEY);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(SCOPED_KEY);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(SCOPED_KEY);
    expect(failureResponse).not.toHaveBeenCalled();
  });
});
