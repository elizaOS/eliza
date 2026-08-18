/** Exercises malformed request input with deterministic route collaborators. */
import { describe, expect, mock, test } from "bun:test";

const emit = mock(async () => ({ event_id: "evt-1" }));

mock.module("@/api-app/services/audit", () => ({
  CLIENT_AUDIT_ACTIONS: [
    "plugin.install",
    "plugin.uninstall",
    "plugin.grant",
    "plugin.revoke",
    "plugin.denied",
    "vision.allowed",
    "vision.denied",
    "data.export",
    "data.delete_request",
    "auth.session.revoke",
    "api_key.revoke",
  ],
}));

mock.module("@/api-app/services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({ emit }),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { warn: () => undefined, error: () => undefined },
}));

const { default: app } = await import("./route");

describe("POST /api/v1/security/audit malformed JSON", () => {
  test("returns 400 instead of 500 and never emits an audit event", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid JSON body",
    });
    expect(emit).not.toHaveBeenCalled();
  });

  test("canonical JSON still emits an audit event", async () => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "plugin.install",
        result: "allow",
      }),
    });
    expect(response.status).toBe(202);
    expect(emit).toHaveBeenCalled();
  });
});
