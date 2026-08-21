/** Proves the mounted health route mirrors the fast-path schema beacon. */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import healthRoute from "./route";

const app = new Hono().route("/api/health", healthRoute);

describe("GET /api/health schema compatibility", () => {
  test("publishes only the value-free usage-quota tombstone marker", async () => {
    const response = await app.request("/api/health", undefined, {
      CF_REGION: "local-test",
      ENVIRONMENT: "staging",
      DATABASE_URL: "never-return-this-database-url",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");

    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      status: "ok",
      region: "local-test",
      environment: "staging",
      schemaCompatibility: {
        usageQuotasTombstone: true,
      },
    });
    expect(text).not.toContain("never-return-this-database-url");
  });
});
