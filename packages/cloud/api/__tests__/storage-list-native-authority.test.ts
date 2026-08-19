/**
 * Exercises the real storage LIST router against a native fake R2 binding,
 * proving legacy discovery is catalog-adopted before a successful charge.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ORG = "00000000-0000-4000-8000-000000021045";
const events: string[] = [];
const requireUserOrApiKeyWithOrg = mock(async () => ({ organization_id: ORG }));
const adoptLegacyObjects = mock();
const listObjects = mock();
const getServiceMethodCost = mock(async () => 0.0001);
const deductCredits = mock(async () => {
  events.push("charge");
  return { success: true };
});

mock.module("@/db/repositories", () => ({
  orgStorageMutationsRepository: { adoptLegacyObjects, listObjects },
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
  adoptLegacyObjects.mockReset();
  listObjects.mockReset();
  deductCredits.mockClear();
  adoptLegacyObjects.mockImplementation(async (inputs) => {
    events.push(`adopt:${inputs.map((input) => input.logicalKey).join(",")}`);
  });
  listObjects.mockResolvedValue([
    {
      logical_key: "voice/message.ogg",
      size_bytes: 5n,
      content_type: "audio/ogg",
      uploaded_at: new Date("2026-08-18T00:00:00.000Z"),
    },
  ]);
});

test("paginates native legacy keys, adopts them, and charges only after success", async () => {
  const list = mock()
    .mockResolvedValueOnce({
      objects: [
        {
          key: `org/${ORG}/voice/message.ogg`,
          size: 5,
          etag: "legacy-etag",
          uploaded: new Date("2026-08-18T00:00:00.000Z"),
          httpMetadata: { contentType: "audio/ogg" },
        },
      ],
      truncated: true,
      cursor: "page-2",
    })
    .mockResolvedValueOnce({ objects: [], truncated: false });
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
  expect(list).toHaveBeenCalledTimes(2);
  expect(adoptLegacyObjects).toHaveBeenCalledWith([
    {
      organizationId: ORG,
      logicalKey: "voice/message.ogg",
      providerKey: `org/${ORG}/voice/message.ogg`,
      sizeBytes: 5n,
      contentType: "audio/ogg",
      etag: "legacy-etag",
      uploadedAt: new Date("2026-08-18T00:00:00.000Z"),
    },
  ]);
  expect(events).toEqual(["adopt:voice/message.ogg", "charge"]);
});

test("does not charge when native listing fails", async () => {
  const response = await app.request("/api/v1/apis/storage/list", undefined, {
    BLOB: {
      list: mock(async () => Promise.reject(new Error("native list failed"))),
    },
  });
  expect(response.status).toBe(500);
  expect(deductCredits).not.toHaveBeenCalled();
});
