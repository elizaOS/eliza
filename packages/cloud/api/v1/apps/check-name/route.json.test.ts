/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const isNameAvailable = mock(async () => ({
  available: true,
  slug: "demo",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/apps", () => ({
  appsService: { isNameAvailable },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps/check-name malformed JSON", () => {
  test("returns 400 instead of 500 and never checks availability", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(isNameAvailable).not.toHaveBeenCalled();
  });

  test("canonical JSON still checks the name", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(response.status).toBe(200);
    expect(isNameAvailable).toHaveBeenCalled();
  });
});
