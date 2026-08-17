/**
 * GET /api/v1/x/status `connectionRole` is owner-vs-agent identity, not a
 * leftover page-size limit. Stock develop used a ternary that mapped every
 * non-"agent" token onto the personal owner X connection. The documented
 * default remains owner; garbage must 400 before `getXCloudStatus`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getXCloudStatus = mock(
  async (_organizationId: string, _role: "owner" | "agent") => ({
    connected: true,
    configured: true,
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/services/x", () => ({
  getXCloudStatus,
  XServiceError: class XServiceError extends Error {},
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/x/status", route);

function getStatus(query = "") {
  return app.request(`/api/v1/x/status${query}`);
}

describe("GET /api/v1/x/status connectionRole identity", () => {
  beforeEach(() => getXCloudStatus.mockClear());

  test.each([
    ["", "owner"],
    ["?connectionRole=", "owner"],
    ["?connectionRole=owner", "owner"],
    ["?connectionRole=agent", "agent"],
  ])("accepts %s as %s", async (query, role) => {
    const response = await getStatus(query);
    expect(response.status).toBe(200);
    expect(getXCloudStatus).toHaveBeenCalledTimes(1);
    expect(getXCloudStatus).toHaveBeenCalledWith("org-1", role);
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n"])(
    "rejects connectionRole=%s before status lookup",
    async (token) => {
      const response = await getStatus(
        `?connectionRole=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/connection_role|connectionRole/i);
      expect(getXCloudStatus).not.toHaveBeenCalled();
    },
  );
});
