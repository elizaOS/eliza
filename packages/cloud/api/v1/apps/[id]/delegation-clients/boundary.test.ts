/** Exercises the real Hono client-management CSRF boundary; registration ownership remains covered by the database-backed delegation suite. */
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";
import { appClientManagementBoundary } from "./_handlers";

test("cookie inventory reads reach authentication without a mutation marker", async () => {
  const app = new Hono<AppEnv>();
  appClientManagementBoundary(app);
  app.get("/", (c) => c.json({ reachedSessionBoundary: true }));
  const response = await app.request(
    "https://cloud.eliza.app/",
    { headers: { cookie: "eliza-test-session=signed-session-owned-by-auth" } },
    { ENVIRONMENT: "test" },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ reachedSessionBoundary: true });
});
test("ambient-cookie mutations still require a trusted origin and explicit request marker", async () => {
  const app = new Hono<AppEnv>();
  appClientManagementBoundary(app);
  app.post("/", (c) => c.json({ reachedMutation: true }));
  const response = await app.request(
    "https://cloud.eliza.app/",
    {
      method: "POST",
      headers: { cookie: "eliza-test-session=signed-session-owned-by-auth" },
    },
    { ENVIRONMENT: "test" },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    success: false,
    code: "forbidden_origin",
  });
});
