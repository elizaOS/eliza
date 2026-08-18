/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const insertExternalDomain = mock(async () => ({ id: "row-1" }));
const getDomainByName = mock(async () => null);
const getOwnDomainRow = mock(async () => null);
const assignToResource = mock(async () => undefined);
const setCustomDomain = mock(async () => undefined);

mock.module("./guards", () => ({
  loadOwnedApp: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    app: { id: "app-1", organization_id: "org-1" },
    appId: "app-1",
  }),
}));

mock.module("@/lib/services/managed-domains", () => ({
  managedDomainsService: {
    getDomainByName,
    getOwnDomainRow,
    insertExternalDomain,
    assignToResource,
    listForApp: async () => [],
    unassignFromResource: async () => undefined,
  },
}));

mock.module("@/lib/services/app-domains-compat", () => ({
  appDomainsCompat: {
    setCustomDomain,
    clearCustomDomain: async () => undefined,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps/:id/domains malformed JSON", () => {
  test("returns 400 instead of 500 and never attaches a domain", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(insertExternalDomain).not.toHaveBeenCalled();
  });

  test("canonical JSON still attaches an external domain", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(201);
    expect(insertExternalDomain).toHaveBeenCalled();
  });

  test("rejects malformed DELETE JSON before domain lookup", async () => {
    getOwnDomainRow.mockClear();
    const response = await app.request("/", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(getOwnDomainRow).not.toHaveBeenCalled();
  });
});
