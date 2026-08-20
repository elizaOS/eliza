/**
 * Exercises the real storage LIST router against a native fake R2 binding,
 * proving logical prefixes stay out of URLs and paid LIST enters durable
 * server-owned receipt authority.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORG = "00000000-0000-4000-8000-000000021045";
const events: string[] = [];
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000021044",
  organization_id: ORG,
}));
const ensureNativeStorageQuotaReconciled = mock(async () => {
  events.push("reconcile");
});
const listObjects = mock();
const getServiceMethodCost = mock(async () => 0.0001);
const executeNativeStorageList = mock();
const deductCredits = mock(async () => {
  events.push("charge");
  return { success: true };
});

mock.module("@/db/repositories", () => ({
  orgStorageMutationsRepository: { listObjects },
}));
mock.module("@/lib/services/storage/native-storage-put", () => ({
  ensureNativeStorageQuotaReconciled,
  resolveNativeStorageObject: mock(),
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
  executeNativeStorageList,
  NativeStorageReadError: TestNativeStorageReadError,
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/proxy/pricing", () => ({ getServiceMethodCost }));
mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits },
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_context: unknown, error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "failure" },
      { status: 500 },
    ),
}));

const route = (await import("../v1/apis/storage/list/route")).default;
const app = new Hono();
app.route("/api/v1/apis/storage/list", route);

beforeEach(() => {
  events.length = 0;
  ensureNativeStorageQuotaReconciled.mockClear();
  listObjects.mockReset();
  deductCredits.mockClear();
  getServiceMethodCost.mockClear();
  listObjects.mockResolvedValue([
    {
      logical_key: "voice/message.ogg",
      size_bytes: 5n,
      content_type: "audio/ogg",
      uploaded_at: new Date("2026-08-18T00:00:00.000Z"),
    },
  ]);
  executeNativeStorageList.mockReset();
  executeNativeStorageList.mockResolvedValue({
    operation: { id: "00000000-0000-4000-8000-000000021046" },
    status: 200,
    body: {
      items: [
        {
          key: "voice/message.ogg",
          size: 5,
          contentType: "audio/ogg",
          modifiedAt: "2026-08-18T00:00:00.000Z",
        },
      ],
      truncated: false,
    },
    replay: false,
  });
});

test("routes a private header prefix through durable paid LIST authority", async () => {
  const list = mock();
  const response = await app.request(
    "/api/v1/apis/storage/list",
    {
      headers: {
        "X-Storage-Prefix": "voice",
        "X-Storage-Recursive": "true",
        "Idempotency-Key": "list-1",
      },
    },
    { BLOB: { list } },
  );

  expect(response.status).toBe(200);
  const responseBody: unknown = await response.json();
  expect(responseBody).toEqual({
    items: [
      {
        key: "voice/message.ogg",
        size: 5,
        contentType: "audio/ogg",
        modifiedAt: "2026-08-18T00:00:00.000Z",
      },
    ],
    truncated: false,
  });
  expect(executeNativeStorageList).toHaveBeenCalledWith({
    bucket: { list },
    organizationId: ORG,
    userId: "00000000-0000-4000-8000-000000021044",
    rawIdempotencyKey: "list-1",
    priceUsd: 0.0001,
    prefix: "voice",
    recursive: true,
    limit: 1000,
  });
  expect(response.headers.get("X-Storage-Receipt-Id")).toBe(
    "00000000-0000-4000-8000-000000021046",
  );
  expect(deductCredits).not.toHaveBeenCalled();
});

test("rejects a logical prefix in URL before billing or provider authority", async () => {
  const response = await app.request(
    "/api/v1/apis/storage/list?prefix=private",
    undefined,
    {
      BLOB: {
        list: mock(),
      },
    },
  );
  expect(response.status).toBe(400);
  expect(executeNativeStorageList).not.toHaveBeenCalled();
  expect(getServiceMethodCost).not.toHaveBeenCalled();
  expect(deductCredits).not.toHaveBeenCalled();
});
