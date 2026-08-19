/**
 * Exercises the real storage presign route and proves authenticated requests
 * are default-denied before provider, catalog, or billing authority can run.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ROUTE_PATH = "/api/v1/apis/storage/presign";
const requireUserOrApiKeyWithOrg = mock();

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

const presignRoute = (await import("../v1/apis/storage/presign/route")).default;
const app = new Hono();
app.route(ROUTE_PATH, presignRoute);

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockReset();
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: "00000000-0000-4000-8000-000000021009",
  });
});

test("default-denies authenticated presign without reading the request key", async () => {
  const response = await app.request(ROUTE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });

  expect(response.status).toBe(503);
  const responseBody: unknown = await response.json();
  expect(responseBody).toEqual({
    error:
      "Storage presigning is unavailable until native signed-read billing authority is enabled",
  });
  expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
});
