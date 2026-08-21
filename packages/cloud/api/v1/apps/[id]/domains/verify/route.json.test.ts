/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const getOwnDomainRow = mock(async () => ({
  id: "md-1",
  appId: "app-1",
  domain: "example.com",
  registrar: "cloudflare",
  verified: true,
}));

mock.module("../guards", () => ({
  loadOwnedApp: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    app: { id: "app-1", organization_id: "org-1" },
    appId: "app-1",
  }),
}));

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: {
    getOwnDomainRow,
    syncStatus: async () => ({ verified: true, verifiedAt: null }),
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { info: () => undefined, warn: () => undefined },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps/:id/domains/verify malformed JSON", () => {
  test("returns 400 instead of 500 and never loads a domain row", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(getOwnDomainRow).not.toHaveBeenCalled();
  });

  test("canonical JSON still verifies a cloudflare domain", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(200);
    expect(getOwnDomainRow).toHaveBeenCalled();
  });
});
