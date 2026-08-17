/**
 * GET /api/v1/x/feed `connectionRole` is owner-vs-agent identity, leftover
 * tax after x/status (#20945). Stock develop used a ternary that mapped
 * every non-"agent" token onto the personal owner X feed. The documented
 * default remains owner; garbage must 400 before `getXFeed`.
 * maxResults / feedType / query parsers stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getXFeed = mock(
  async (_args: {
    organizationId: string;
    connectionRole: "owner" | "agent";
    feedType?: string;
    query?: string;
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
  getXFeed,
  XServiceError: class XServiceError extends Error {},
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "internal_error" }, 500),
}));

const route = (await import("./route")).default;
const app = new Hono().route("/api/v1/x/feed", route);

function getFeed(query = "") {
  return app.request(`/api/v1/x/feed${query}`);
}

describe("GET /api/v1/x/feed connectionRole identity", () => {
  beforeEach(() => getXFeed.mockClear());

  test.each([
    ["", "owner"],
    ["?connectionRole=", "owner"],
    ["?connectionRole=owner", "owner"],
    ["?connectionRole=agent", "agent"],
  ])("accepts %s as %s", async (query, role) => {
    const response = await getFeed(query);
    expect(response.status).toBe(200);
    expect(getXFeed).toHaveBeenCalledTimes(1);
    expect(getXFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        connectionRole: role,
      }),
    );
  });

  test.each(["AGENT", "Owner", "foo", "1e2", "agent ", "owner\n"])(
    "rejects connectionRole=%s before feed lookup",
    async (token) => {
      const response = await getFeed(
        `?connectionRole=${encodeURIComponent(token)}`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toMatch(/connection_role|connectionRole/i);
      expect(getXFeed).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?connectionRole=agent&connectionRole=agent",
    "?connectionRole=agent&connectionRole=owner",
    "?connectionRole=&connectionRole=agent",
    "?connectionRole=foo&connectionRole=owner",
  ])(
    "rejects duplicate role values in %s before feed lookup",
    async (query) => {
      const response = await getFeed(query);
      expect(response.status).toBe(400);
      expect(getXFeed).not.toHaveBeenCalled();
    },
  );
});
