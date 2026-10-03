/**
 * Google connect initiate body validation.
 *
 * Exercises the REAL route module (`./route`) with its auth and connector
 * dependencies mocked via `mock.module`. The connector mock keeps a call
 * ledger so assertions check both the response and whether the mutation ran.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const initiateCalls: Array<{
  organizationId: string;
  userId: string;
  side: "owner" | "agent";
  redirectUrl?: string;
  capabilities?: string[];
}> = [];

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) =>
    new Response(JSON.stringify({ error: String(error) }), { status: 500 }),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: "org-1",
  }),
}));

mock.module("@/lib/services/agent-google-connector", () => ({
  AgentGoogleConnectorError: class AgentGoogleConnectorError extends Error {
    status = 400;
  },
  initiateManagedGoogleConnection: async (args: {
    organizationId: string;
    userId: string;
    side: "owner" | "agent";
    redirectUrl?: string;
    capabilities?: string[];
  }) => {
    initiateCalls.push(args);
    return {
      ok: true,
      url: "https://accounts.google.com/o/oauth2/auth?state=test",
    };
  },
}));

const { default: initiateRoute } = await import("./route");

function mounted<E extends Parameters<typeof Hono>[0]>(
  route: Hono<E>,
  path: string,
): Hono {
  return new Hono<E>().route(path, route);
}

const app = mounted(initiateRoute, "/api/v1/eliza/google/connect/initiate");

function post(body: string) {
  return app.request("/api/v1/eliza/google/connect/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  initiateCalls.length = 0;
});

describe("google connect initiate body validation", () => {
  test("rejects a truncated non-empty body before any connector call", async () => {
    const response = await post("{");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("not valid JSON");
    expect(initiateCalls).toHaveLength(0);
  });

  test("keeps the empty-body initiate-with-defaults contract", async () => {
    const response = await post("");
    expect(response.status).toBe(200);
    expect(initiateCalls).toHaveLength(1);
    expect(initiateCalls[0]).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      side: "owner",
      redirectUrl: undefined,
      capabilities: undefined,
    });
  });

  test("keeps the whitespace-only body contract", async () => {
    const response = await post("   ");
    expect(response.status).toBe(200);
    expect(initiateCalls).toHaveLength(1);
  });

  test("forwards explicit options without inventing defaults", async () => {
    const response = await post(
      JSON.stringify({ side: "agent", redirectUrl: "https://app.example/cb" }),
    );
    expect(response.status).toBe(200);
    expect(initiateCalls).toHaveLength(1);
    expect(initiateCalls[0]?.side).toBe("agent");
    expect(initiateCalls[0]?.redirectUrl).toBe("https://app.example/cb");
  });

  test("still rejects schema-invalid JSON with 400", async () => {
    const response = await post(JSON.stringify({ side: "bogus" }));
    expect(response.status).toBe(400);
    expect(initiateCalls).toHaveLength(0);
  });
});
