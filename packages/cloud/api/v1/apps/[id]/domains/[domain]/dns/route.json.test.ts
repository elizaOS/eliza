/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const createRecord = mock(async () => ({
  id: "rec-1",
  type: "A",
}));

mock.module("../../guards", () => ({
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
    listRecords: async () => [],
    createRecord,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: () => undefined, info: () => undefined },
}));

mock.module("@/lib/utils/error-handling", () => ({
  extractErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps/:id/domains/:domain/dns malformed JSON", () => {
  test("returns 400 instead of 500 and never creates a record", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(createRecord).not.toHaveBeenCalled();
  });

  test("canonical JSON still creates a DNS record", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "A",
        name: "www",
        content: "1.2.3.4",
      }),
    });
    expect(response.status).toBe(201);
    expect(createRecord).toHaveBeenCalled();
  });
});
