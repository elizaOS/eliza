/**
 * Route-boundary tests for GET /api/v1/twitter/token connectionRole handling.
 *
 * The owner connection is the user's personal X account. The prior ternary
 * mapped every non-"agent" query value — including a missing or mistyped
 * parameter — to "owner", so an org API key plus a typo silently vended the
 * owner's personal credentials. The route must default to the
 * least-privileged agent connection, accept only the exact enum, and reach
 * the credential service with exactly the validated role.
 */

import { describe, expect, mock, test } from "bun:test";

const getBrokerCredentials = mock(
  async (_orgId: string, _userId: string, role: "agent" | "owner") => ({
    authMode: "oauth2" as const,
    accessToken: `token-for-${role}`,
    expiresAt: null,
    scope: null,
    twitterUserId: null,
  }),
);

mock.module("@/lib/services/twitter-automation", () => ({
  twitterAutomationService: { getBrokerCredentials },
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-1",
    organization_id: "org-1",
    organization: { id: "org-1", name: "Org", is_active: true },
  })),
}));

const { default: app } = await import("../v1/twitter/token/route");

async function get(path: string): Promise<Response> {
  return await app.request(path, { method: "GET" });
}

describe("GET /api/v1/twitter/token — connectionRole boundary", () => {
  test("missing connectionRole defaults to the agent connection", async () => {
    getBrokerCredentials.mockClear();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(getBrokerCredentials.mock.calls[0]?.[2]).toBe("agent");
  });

  test("explicit agent and owner pass through exactly", async () => {
    getBrokerCredentials.mockClear();
    expect((await get("/?connectionRole=agent")).status).toBe(200);
    expect(getBrokerCredentials.mock.calls[0]?.[2]).toBe("agent");

    getBrokerCredentials.mockClear();
    expect((await get("/?connectionRole=owner")).status).toBe(200);
    expect(getBrokerCredentials.mock.calls[0]?.[2]).toBe("owner");
  });

  test("garbage roles are a 400, never a silent owner vend", async () => {
    getBrokerCredentials.mockClear();
    for (const bad of ["admin", "Owner", "OWNER", "agent%20", "root", ""]) {
      const res = await get(`/?connectionRole=${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_connection_role");
    }
    expect(getBrokerCredentials).not.toHaveBeenCalled();
  });
});
