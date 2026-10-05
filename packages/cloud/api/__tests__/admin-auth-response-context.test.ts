/**
 * The admin routes that authenticate through requireAdminWithResponse must
 * hand requireAdmin the Hono context: unauthenticated callers get 401 and an
 * authorized admin reaches the handler (here its org-id validation) instead
 * of an internal error.
 */
import { describe, expect, test } from "bun:test";

const route = (await import("../v1/admin/orgs/[orgId]/rate-limits/route"))
  .default;

describe("GET /api/v1/admin/orgs/:orgId/rate-limits", () => {
  test("rejects a request without credentials with 401", async () => {
    const res = await route.request(
      "/",
      { method: "GET" },
      {
        NODE_ENV: "production",
      },
    );

    expect(res.status).toBe(401);
  });

  test("lets an authorized local dev admin reach the handler", async () => {
    const res = await route.request(
      "http://localhost/",
      { method: "GET" },
      { NODE_ENV: "development", ELIZA_CLOUD_LOCAL_DEV_ADMIN: "true" },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid org ID" });
  });
});
