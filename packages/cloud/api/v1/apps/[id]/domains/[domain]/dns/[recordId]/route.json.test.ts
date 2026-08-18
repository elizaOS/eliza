/** Exercises malformed request input with deterministic route collaborators. */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const updateRecord = mock(async () => ({
  id: "rec-1",
  type: "A",
  content: "1.2.3.4",
}));

mock.module("../../../guards", () => ({
  loadCloudflareManagedDomain: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    app: { id: "app-1", organization_id: "org-1" },
    appId: "app-1",
    domain: {
      domain: "example.com",
      cloudflareZoneId: "zone-1",
    },
  }),
}));

mock.module("@/lib/services/cloudflare-dns", () => ({
  cloudflareDnsService: {
    getRecord: async () => ({ id: "rec-1" }),
    updateRecord,
    deleteRecord: async () => undefined,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { default: route } = await import("./route");
const app = new Hono();
app.route("/:recordId", route);

describe("PATCH /api/v1/apps/:id/domains/:domain/dns/:recordId malformed JSON", () => {
  test("returns 400 instead of 500 and never writes a record", async () => {
    const response = await app.request("/rec-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updateRecord).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates a DNS record", async () => {
    const response = await app.request("/rec-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "1.2.3.4" }),
    });
    expect(response.status).toBe(200);
    expect(updateRecord).toHaveBeenCalled();
  });
});
