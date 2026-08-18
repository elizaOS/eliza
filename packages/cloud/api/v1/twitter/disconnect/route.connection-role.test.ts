/** Exercises Twitter disconnect role validation before credential mutation. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const removeCredentials = mock(async () => undefined);
const invalidateOAuthState = mock(async () => undefined);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { removeCredentials },
}));
mock.module("@/lib/services/oauth/invalidation", () => ({
  invalidateOAuthState,
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/twitter/disconnect", route);

function disconnect(query = "") {
  return app.request(`/api/v1/twitter/disconnect${query}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/v1/twitter/disconnect connectionRole identity", () => {
  beforeEach(() => {
    removeCredentials.mockClear();
    invalidateOAuthState.mockClear();
  });

  test.each([
    ["", "owner"],
    ["?connectionRole=", "owner"],
    ["?connectionRole=owner", "owner"],
    ["?connectionRole=agent", "agent"],
  ])("accepts %s as %s", async (query, role) => {
    const response = await disconnect(query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { connectionRole: string };
    expect(body.connectionRole).toBe(role);
    expect(removeCredentials).toHaveBeenCalledTimes(1);
    expect(removeCredentials).toHaveBeenCalledWith("org-1", "user-1", role);
    expect(invalidateOAuthState).toHaveBeenCalledTimes(1);
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n"])(
    "rejects connectionRole=%s before credential removal",
    async (token) => {
      const response = await disconnect(
        `?connectionRole=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/connection_role|connectionRole/i);
      expect(removeCredentials).not.toHaveBeenCalled();
      expect(invalidateOAuthState).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?connectionRole=agent&connectionRole=agent",
    "?connectionRole=agent&connectionRole=owner",
    "?connectionRole=&connectionRole=agent",
    "?connectionRole=foo&connectionRole=owner",
  ])(
    "rejects duplicate role values in %s before credential removal",
    async (query) => {
      const response = await disconnect(query);
      expect(response.status).toBe(400);
      expect(removeCredentials).not.toHaveBeenCalled();
      expect(invalidateOAuthState).not.toHaveBeenCalled();
    },
  );
});
