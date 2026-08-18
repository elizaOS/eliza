/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const checkAvailability = mock(async () => ({
  available: false,
}));

mock.module("../guards", () => ({
  loadOwnedApp: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    app: { id: "app-1", organization_id: "org-1" },
    appId: "app-1",
  }),
}));

mock.module("@/lib/services/cloudflare-registrar", () => ({
  cloudflareRegistrarService: { checkAvailability },
}));

mock.module("@/lib/services/domain-pricing", () => ({
  computeDomainPrice: (cents: number) => ({
    wholesaleUsdCents: cents,
    marginUsdCents: 0,
    totalUsdCents: cents,
    marginBps: 0,
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, info: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/apps/:id/domains/check malformed JSON", () => {
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
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  test("canonical JSON still checks availability", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(response.status).toBe(200);
    expect(checkAvailability).toHaveBeenCalled();
  });
});
