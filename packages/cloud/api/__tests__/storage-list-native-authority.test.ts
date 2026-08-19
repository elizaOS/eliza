/**
 * Exercises the real storage LIST router against a native fake R2 binding,
 * proving legacy discovery is catalog-adopted while paid LIST is disabled.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORG = "00000000-0000-4000-8000-000000021045";
const events: string[] = [];
const requireUserOrApiKeyWithOrg = mock(async () => ({ organization_id: ORG }));
const ensureNativeStorageQuotaReconciled = mock(async () => {
  events.push("reconcile");
});
const listObjects = mock();
const getServiceMethodCost = mock(async () => 0.0001);
const deductCredits = mock(async () => {
  events.push("charge");
  return { success: true };
});

mock.module("@/db/repositories", () => ({
  orgStorageMutationsRepository: { listObjects },
}));
mock.module("@/lib/services/storage/native-storage-put", () => ({
  ensureNativeStorageQuotaReconciled,
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
  listObjects.mockResolvedValue([
    {
      logical_key: "voice/message.ogg",
      size_bytes: 5n,
      content_type: "audio/ogg",
      uploaded_at: new Date("2026-08-18T00:00:00.000Z"),
    },
  ]);
});

test("reconciles native authority without activating incomplete paid LIST", async () => {
  const list = mock();
  const response = await app.request(
    "/api/v1/apis/storage/list?prefix=voice&recursive=true",
    undefined,
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
  expect(ensureNativeStorageQuotaReconciled).toHaveBeenCalled();
  expect(listObjects).toHaveBeenCalledWith(ORG, "voice", 1001, true);
  expect(events).toEqual(["reconcile"]);
  expect(getServiceMethodCost).not.toHaveBeenCalled();
  expect(deductCredits).not.toHaveBeenCalled();
});

test("does not charge when native listing fails", async () => {
  ensureNativeStorageQuotaReconciled.mockRejectedValueOnce(
    new Error("native list failed"),
  );
  const response = await app.request("/api/v1/apis/storage/list", undefined, {
    BLOB: {
      list: mock(),
    },
  });
  expect(response.status).toBe(500);
  expect(deductCredits).not.toHaveBeenCalled();
});
