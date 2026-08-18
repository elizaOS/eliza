/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const ensureStewardTenant = mock(async () => ({
  tenantId: "tenant-1",
  isNew: true,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/steward-platform-users", () => ({
  isStewardPlatformConfigured: () => true,
}));

mock.module("@/lib/services/steward-tenant-config", () => ({
  ensureStewardTenant,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/steward/tenants request validation", () => {
  test("returns 400 instead of 500 and never provisions a tenant", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(ensureStewardTenant).not.toHaveBeenCalled();
  });

  test("rejects a null JSON body before provisioning a tenant", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(response.status).toBe(400);
    expect(ensureStewardTenant).not.toHaveBeenCalled();
  });

  test("canonical JSON still provisions a tenant", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org-1" }),
    });
    expect(response.status).toBe(201);
    expect(ensureStewardTenant).toHaveBeenCalled();
  });
});
