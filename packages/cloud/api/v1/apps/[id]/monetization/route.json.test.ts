/**
 * PUT /api/v1/apps/:id/monetization used to let request.json() throw into the
 * route-wide catch, which returned 500. Malformed JSON is caller error.
 */
import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
  apiKey: null,
}));
const isAppKeyOutOfScope = mock(async () => false);
const getById = mock(async () => ({
  id: "app-1",
  organization_id: "org-1",
  review_status: "approved",
}));
const updateMonetizationSettings = mock(async () => undefined);
const getMonetizationSettings = mock(async () => ({
  monetizationEnabled: false,
}));

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));
mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope,
}));
mock.module("@/lib/services/apps", () => ({
  appsService: { getById },
}));
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    updateMonetizationSettings,
    getMonetizationSettings,
  },
}));
mock.module("@/lib/services/app-review", () => ({
  isAppMonetizationApproved: () => true,
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:id", route);

describe("PUT /api/v1/apps/:id/monetization malformed JSON", () => {
  test("returns 400 instead of 500 and never writes settings", async () => {
    const response = await app.request("/app-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid JSON in request body",
    });
    expect(updateMonetizationSettings).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates settings", async () => {
    const response = await app.request("/app-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ monetizationEnabled: false }),
    });
    expect(response.status).toBe(200);
    expect(updateMonetizationSettings).toHaveBeenCalled();
  });
});
