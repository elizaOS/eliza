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
import type { Bindings } from "@/types/cloud-worker-env";

const coordinatorFetch = mock(
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as {
      connectionRole: "agent" | "owner";
    };
    return Response.json({
      auth_mode: "oauth2",
      access_token: `token-for-${request.connectionRole}`,
    });
  },
);
const getByName = mock((_name: string) => ({ fetch: coordinatorFetch }));
const env = {
  TWITTER_OAUTH_REFRESH_COORDINATORS: { getByName },
} as unknown as Bindings;

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-1",
    organization_id: "org-1",
    organization: { id: "org-1", name: "Org", is_active: true },
  })),
}));

const { default: app } = await import("../v1/twitter/token/route");

async function get(path: string): Promise<Response> {
  return await app.request(path, { method: "GET" }, env);
}

describe("GET /api/v1/twitter/token — connectionRole boundary", () => {
  test("missing connectionRole defaults to the agent connection", async () => {
    coordinatorFetch.mockClear();
    getByName.mockClear();
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(getByName).toHaveBeenCalledWith("org-1:agent");
    expect(await res.json()).toMatchObject({ access_token: "token-for-agent" });
  });

  test("explicit agent and owner pass through exactly", async () => {
    coordinatorFetch.mockClear();
    expect((await get("/?connectionRole=agent")).status).toBe(200);
    expect(
      JSON.parse(String(coordinatorFetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      connectionRole: "agent",
    });

    coordinatorFetch.mockClear();
    expect((await get("/?connectionRole=owner")).status).toBe(200);
    expect(
      JSON.parse(String(coordinatorFetch.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      connectionRole: "owner",
    });
  });

  test("garbage roles are a 400, never a silent owner vend", async () => {
    coordinatorFetch.mockClear();
    for (const bad of ["admin", "Owner", "OWNER", "agent%20", "root", ""]) {
      const res = await get(`/?connectionRole=${bad}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("invalid_connection_role");
    }
    expect(coordinatorFetch).not.toHaveBeenCalled();
  });
});
