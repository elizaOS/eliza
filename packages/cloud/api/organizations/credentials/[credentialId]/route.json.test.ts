/**
 * PATCH /api/organizations/credentials/:credentialId used to let c.req.json()
 * throw into failureResponse, which maps SyntaxError to 500.
 * Malformed JSON is caller error.
 */
import { Hono } from "hono";
import { describe, expect, mock, test } from "bun:test";

const updatePooledCredential = mock(async () => ({
  id: "cred-1",
  enabled: true,
}));
const getPooledCredential = mock(async () => ({
  id: "cred-1",
  organization_id: "org-1",
  contributed_by: "user-1",
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
    role: "owner",
  }),
}));

mock.module("@/lib/services/team-credential-pool/service", () => ({
  TeamCredentialPoolError: class TeamCredentialPoolError extends Error {
    status = 400;
  },
  getPooledCredential,
  removePooledCredential: async () => undefined,
  updatePooledCredential,
}));

mock.module("../../../src/middleware/org-membership", () => ({
  assertOrgMembership: async () => undefined,
}));

const { default: route } = await import("./route");
const app = new Hono().route("/:credentialId", route);

describe("PATCH /api/organizations/credentials/:credentialId malformed JSON", () => {
  test("returns 400 instead of 500 and never updates a credential", async () => {
    const response = await app.request("/cred-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(updatePooledCredential).not.toHaveBeenCalled();
  });

  test("canonical JSON still updates a credential", async () => {
    const response = await app.request("/cred-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(response.status).toBe(200);
    expect(updatePooledCredential).toHaveBeenCalled();
  });
});
