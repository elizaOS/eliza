/**
 * #33073: the Google disconnect route must not fold a malformed non-empty JSON
 * body into its defaults. A truncated body is a client error (400) and must
 * never reach the connector; an absent or empty body keeps the documented
 * disconnect-on-side contract.
 *
 * Exercises the REAL route module (`./route`) with its auth and connector
 * dependencies mocked via `mock.module`, mounted at the real path the way
 * `agent-inference-markup-retired.test.ts` mounts sibling routes. The
 * connector mock keeps a call ledger so assertions check both the response
 * and whether the mutation ran.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const disconnectCalls: Array<{
  organizationId: string;
  userId: string;
  side: "owner" | "agent";
  connectionId: string | null;
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
  disconnectManagedGoogleConnection: async (args: {
    organizationId: string;
    userId: string;
    side: "owner" | "agent";
    connectionId: string | null;
  }) => {
    disconnectCalls.push(args);
    return { ok: true };
  },
}));

const { default: disconnectRoute } = await import("./route");

function mounted<E extends Parameters<typeof Hono>[0]>(
  route: Hono<E>,
  path: string,
): Hono {
  return new Hono<E>().route(path, route);
}

const app = mounted(disconnectRoute, "/api/v1/eliza/google/disconnect");

function post(body: string) {
  return app.request("/api/v1/eliza/google/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  disconnectCalls.length = 0;
});

describe("google disconnect body validation (#33073)", () => {
  test("rejects a truncated non-empty body before any connector call", async () => {
    const response = await post("{");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("not valid JSON");
    expect(disconnectCalls).toHaveLength(0);
  });

  test("keeps the empty-body disconnect-on-side contract", async () => {
    const response = await post("");
    expect(response.status).toBe(200);
    expect(disconnectCalls).toHaveLength(1);
    expect(disconnectCalls[0]).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      side: "owner",
      connectionId: null,
    });
  });

  test("keeps the whitespace-only body contract", async () => {
    const response = await post("   ");
    expect(response.status).toBe(200);
    expect(disconnectCalls).toHaveLength(1);
  });

  test("forwards an explicit side without inventing a connection id", async () => {
    const response = await post(JSON.stringify({ side: "agent" }));
    expect(response.status).toBe(200);
    expect(disconnectCalls).toHaveLength(1);
    expect(disconnectCalls[0]?.side).toBe("agent");
    expect(disconnectCalls[0]?.connectionId).toBeNull();
  });

  test("still rejects schema-invalid JSON with 400", async () => {
    const response = await post(JSON.stringify({ side: "bogus" }));
    expect(response.status).toBe(400);
    expect(disconnectCalls).toHaveLength(0);
  });

  test("accepts an explicit null connectionId as the documented side-wide request", async () => {
    const response = await post(JSON.stringify({ connectionId: null }));
    expect(response.status).toBe(200);
    expect(disconnectCalls).toHaveLength(1);
    expect(disconnectCalls[0]?.connectionId).toBeNull();
  });
});
