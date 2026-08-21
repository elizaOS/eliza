/** Exercises X DM digest role validation before service lookup. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getXDmDigest = mock(
  async (_args: {
    organizationId: string;
    connectionRole: "owner" | "agent";
    maxResults?: number;
  }) => ({
    items: [],
  }),
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));
mock.module("@/lib/services/x", () => ({
  getXDmDigest,
  XServiceError: class XServiceError extends Error {},
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/x/dms/digest", route);

function getDigest(query = "") {
  return app.request(`/api/v1/x/dms/digest${query}`);
}

describe("GET /api/v1/x/dms/digest connectionRole identity", () => {
  beforeEach(() => getXDmDigest.mockClear());

  test.each([
    ["", "owner"],
    ["?connectionRole=", "owner"],
    ["?connectionRole=owner", "owner"],
    ["?connectionRole=agent", "agent"],
  ])("accepts %s as %s", async (query, role) => {
    const response = await getDigest(query);
    expect(response.status).toBe(200);
    expect(getXDmDigest).toHaveBeenCalledTimes(1);
    expect(getXDmDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        connectionRole: role,
      }),
    );
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n"])(
    "rejects connectionRole=%s before digest lookup",
    async (token) => {
      const response = await getDigest(
        `?connectionRole=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/connection_role|connectionRole/i);
      expect(getXDmDigest).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?connectionRole=agent&connectionRole=agent",
    "?connectionRole=agent&connectionRole=owner",
    "?connectionRole=&connectionRole=agent",
    "?connectionRole=foo&connectionRole=owner",
  ])(
    "rejects duplicate role values in %s before digest lookup",
    async (query) => {
      const response = await getDigest(query);
      expect(response.status).toBe(400);
      expect(getXDmDigest).not.toHaveBeenCalled();
    },
  );
});
