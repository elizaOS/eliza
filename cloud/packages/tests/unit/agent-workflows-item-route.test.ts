/**
 * Unit tests for /api/v1/agents/[agentId]/workflows/[workflowId] (GET, PUT, DELETE).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "wf_abc123";

interface ProxyCall {
  agentId: string;
  orgId: string;
  workflowPath: string;
  method: string;
  body?: string | null;
  query?: string;
}

interface Harness {
  authResult: () => Promise<{
    id: string;
    organization_id: string;
    organization: { id: string; is_active: boolean };
    is_active: boolean;
  }>;
  proxyResponse: () => Promise<Response | null>;
  proxyCalls: ProxyCall[];
}

function installMocks(h: Harness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => h.authResult(),
  }));

  mock.module("@/lib/services/eliza-sandbox", () => ({
    elizaSandboxService: {
      proxyWorkflowRequest: async (
        agentId: string,
        orgId: string,
        workflowPath: string,
        method: string,
        body?: string | null,
        query?: string,
      ) => {
        h.proxyCalls.push({ agentId, orgId, workflowPath, method, body, query });
        return h.proxyResponse();
      },
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) => {
      const e = error as { name?: string; message?: string };
      const status =
        e?.name === "AuthenticationError"
          ? 401
          : e?.name === "NotFoundError"
            ? 404
            : e?.name === "ValidationError"
              ? 400
              : 500;
      return new Response(JSON.stringify({ error: e?.message ?? String(error) }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
    NotFoundError: (m = "Resource not found") => {
      const e = new Error(m);
      e.name = "NotFoundError";
      return e;
    },
    ValidationError: (m = "Validation error") => {
      const e = new Error(m);
      e.name = "ValidationError";
      return e;
    },
  }));
}

const validUser: Harness["authResult"] = async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
  organization: { id: ORG_ID, is_active: true },
  is_active: true,
});

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  return {
    authResult: validUser,
    proxyResponse: async () =>
      new Response(JSON.stringify({ id: WORKFLOW_ID }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    proxyCalls: [],
    ...overrides,
  };
}

interface RouteApp {
  fetch: (req: Request) => Response | Promise<Response>;
}

async function loadRoute(): Promise<RouteApp> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/agents/[agentId]/workflows/[workflowId]/route.ts?test=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/agents/:agentId/workflows/:workflowId", inner);
  return parent;
}

describe("agent workflows route: get/update/delete", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("GET forwards to /workflows/:id", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadRoute();

    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}`),
    );

    expect(res.status).toBe(200);
    expect(harness.proxyCalls[0]).toMatchObject({
      method: "GET",
      workflowPath: `workflows/${WORKFLOW_ID}`,
      agentId: AGENT_ID,
      orgId: ORG_ID,
    });
  });

  test("PUT forwards body verbatim", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadRoute();

    const payload = JSON.stringify({ name: "renamed" });
    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}`, {
        method: "PUT",
        body: payload,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(200);
    expect(harness.proxyCalls[0]).toMatchObject({
      method: "PUT",
      workflowPath: `workflows/${WORKFLOW_ID}`,
      body: payload,
    });
  });

  test("DELETE forwards with no body", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadRoute();

    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}`, {
        method: "DELETE",
      }),
    );

    expect(res.status).toBe(200);
    expect(harness.proxyCalls[0]).toMatchObject({
      method: "DELETE",
      workflowPath: `workflows/${WORKFLOW_ID}`,
    });
  });

  test("rejects malformed workflow id with 400", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadRoute();

    const badId = "not%2Fa%2Fworkflow"; // decodes to "not/a/workflow" → contains '/'
    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${badId}`),
    );

    expect(res.status).toBe(400);
    expect(harness.proxyCalls).toHaveLength(0);
  });

  test("returns 401 when auth fails", async () => {
    const harness = makeHarness({
      authResult: async () => {
        const err = new Error("unauthorized");
        err.name = "AuthenticationError";
        throw err;
      },
    });
    installMocks(harness);
    const route = await loadRoute();

    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}`),
    );

    expect(res.status).toBe(401);
    expect(harness.proxyCalls).toHaveLength(0);
  });

  test("returns 404 when not owned / not running", async () => {
    const harness = makeHarness({ proxyResponse: async () => null });
    installMocks(harness);
    const route = await loadRoute();

    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}`),
    );

    expect(res.status).toBe(404);
  });
});
