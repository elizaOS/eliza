/**
 * Unit tests for POST /api/v1/agents/[agentId]/workflows/[workflowId]/run.
 *
 * NOTE: the agent-side endpoint is not currently mounted in
 * plugins/plugin-workflow/src/plugin-routes.ts (only :id/activate and
 * :id/deactivate are). These tests exercise the cloud-side proxy
 * forwarding correctness; once the agent mounts /run, this becomes a
 * live trigger path with no cloud changes required.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKFLOW_ID = "wf_run_42";

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
      new Response(JSON.stringify({ executionId: "exec_1", statusUrl: "/.../exec_1" }), {
        status: 202,
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
      `../../../apps/api/v1/agents/[agentId]/workflows/[workflowId]/run/route.ts?test=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/agents/:agentId/workflows/:workflowId/run", inner);
  return parent;
}

describe("agent workflow run route", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("forwards POST to /workflows/:id/run with body intact", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadRoute();

    const payload = JSON.stringify({ inputs: { x: 1 } });
    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/run`, {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(202);
    expect(harness.proxyCalls[0]).toMatchObject({
      agentId: AGENT_ID,
      orgId: ORG_ID,
      method: "POST",
      workflowPath: `workflows/${WORKFLOW_ID}/run`,
      body: payload,
    });
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
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/run`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(401);
    expect(harness.proxyCalls).toHaveLength(0);
  });

  test("returns 404 when sandbox returns null", async () => {
    const harness = makeHarness({ proxyResponse: async () => null });
    installMocks(harness);
    const route = await loadRoute();

    const res = await route.fetch(
      new Request(`https://api.test/api/v1/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/run`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(res.status).toBe(404);
  });
});
