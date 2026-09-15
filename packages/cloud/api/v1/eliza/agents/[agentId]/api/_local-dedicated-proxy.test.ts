/**
 * Verifies the loopback Dedicated proxy middleware: sentinel gating, ownership
 * and tier fall-through, readiness and credential 503s, the Cloud-to-runtime
 * credential swap, cookie and set-cookie stripping, path/query forwarding, and
 * preflight. Real Hono routing with the real health sibling mounted; the
 * repository, Cloud auth, CORS, Shared resolver, and upstream fetch are
 * deterministic fakes.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const OWNER_ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "cccccccc-4444-4444-8444-444444444444";
const RUNTIME_ORIGIN = "http://127.0.0.1:8790";

type SandboxRow = {
  id: string;
  organization_id: string;
  execution_tier: string;
  status: string;
  headscale_ip: string | null;
  bridge_url: string | null;
  health_url: string | null;
  environment_vars: Record<string, string>;
};

function runningSandbox(overrides: Partial<SandboxRow> = {}): SandboxRow {
  return {
    id: AGENT,
    organization_id: OWNER_ORG,
    execution_tier: "dedicated-always",
    status: "running",
    headscale_ip: null,
    bridge_url: null,
    health_url: `${RUNTIME_ORIGIN}/api/health`,
    environment_vars: { ELIZA_API_TOKEN: "agent-token-1" },
    ...overrides,
  };
}

const sandboxes = new Map<string, SandboxRow>();
const lookups: Array<{ id: string; orgId: string }> = [];
let authedOrg = OWNER_ORG;
let resolveSharedAgentCalls = 0;

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg: async (id: string, orgId: string) => {
      lookups.push({ id, orgId });
      const row = sandboxes.get(id);
      return row && row.organization_id === orgId ? row : undefined;
    },
  },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: authedOrg,
  }),
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response, methods?: string) => {
    const headers = new Headers(response.headers);
    headers.set("x-test-cors", methods ?? "");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  handleCorsOptions: (methods: string) =>
    new Response(null, { status: 204, headers: { "x-test-cors": methods } }),
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent: async () => {
    resolveSharedAgentCalls += 1;
    return { error: "Not a shared-runtime agent", status: 404 };
  },
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestHealth: () => ({ status: "ok", runtime: "shared" }),
}));

const { proxyLocalDedicatedOrNext } = await import("./_local-dedicated-proxy");
const { default: healthRoute } = await import("./health/route");

type UpstreamCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};
const upstreamCalls: UpstreamCall[] = [];
let upstreamResponse: () => Response = () =>
  Response.json({ ok: true }, { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  upstreamCalls.push({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text(),
  });
  return upstreamResponse();
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const catchAll = new Hono<AppEnv>();
  catchAll.use("*", proxyLocalDedicatedOrNext);
  catchAll.all("/", (c) =>
    Response.json({
      handler: "shared-catch-all",
      agentId: c.req.param("agentId"),
    }),
  );
  app.route("/api/v1/eliza/agents/:agentId/api/health", healthRoute);
  app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", catchAll);
  return app;
}

async function request(
  path: string,
  init: RequestInit = {},
  baseDomain: string | undefined = "https://",
): Promise<Response> {
  return await buildApp().request(`http://cloud.local${path}`, init, {
    ELIZA_CLOUD_AGENT_BASE_DOMAIN: baseDomain,
  } as unknown as AppEnv["Bindings"]);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  sandboxes.clear();
  lookups.length = 0;
  upstreamCalls.length = 0;
  authedOrg = OWNER_ORG;
  resolveSharedAgentCalls = 0;
  upstreamResponse = () => Response.json({ ok: true }, { status: 200 });
});

describe("proxyLocalDedicatedOrNext", () => {
  test("stays inert outside the local https:// sentinel mode", async () => {
    sandboxes.set(AGENT, runningSandbox());
    const response = await request(
      `/api/v1/eliza/agents/${AGENT}/api/status`,
      {},
      "cloud.eliza.app",
    );
    expect(await readJson(response)).toEqual({
      handler: "shared-catch-all",
      agentId: AGENT,
    });
    expect(lookups).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });

  test("falls through for non-UUID, unknown, foreign-org, and Shared agents", async () => {
    const personal = "personal:00000000-0000-5000-8000-000000000001";
    expect(
      await readJson(
        await request(
          `/api/v1/eliza/agents/${encodeURIComponent(personal)}/api/status`,
        ),
      ),
    ).toMatchObject({ handler: "shared-catch-all" });
    expect(lookups).toEqual([]);

    expect(
      await readJson(await request(`/api/v1/eliza/agents/${AGENT}/api/status`)),
    ).toMatchObject({ handler: "shared-catch-all" });
    expect(lookups).toEqual([{ id: AGENT, orgId: OWNER_ORG }]);

    sandboxes.set(AGENT, runningSandbox());
    authedOrg = OTHER_ORG;
    expect(
      await readJson(await request(`/api/v1/eliza/agents/${AGENT}/api/status`)),
    ).toMatchObject({ handler: "shared-catch-all" });
    authedOrg = OWNER_ORG;

    sandboxes.set(AGENT, runningSandbox({ execution_tier: "shared" }));
    expect(
      await readJson(await request(`/api/v1/eliza/agents/${AGENT}/api/status`)),
    ).toMatchObject({ handler: "shared-catch-all" });
    expect(upstreamCalls).toEqual([]);
  });

  test("reports a non-running owned Dedicated agent as retryable 503", async () => {
    sandboxes.set(AGENT, runningSandbox({ status: "starting" }));
    const response = await request(`/api/v1/eliza/agents/${AGENT}/api/status`);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await readJson(response)).toEqual({
      success: false,
      code: "agent_not_running",
      error: "Dedicated agent is not running yet",
      data: { status: "starting" },
    });
    expect(upstreamCalls).toEqual([]);
  });

  test("refuses to forward without a loopback base or an agent token", async () => {
    sandboxes.set(AGENT, runningSandbox({ environment_vars: {} }));
    const noToken = await request(`/api/v1/eliza/agents/${AGENT}/api/status`);
    expect(noToken.status).toBe(503);
    expect(await readJson(noToken)).toMatchObject({
      code: "agent_unavailable",
    });

    sandboxes.set(
      AGENT,
      runningSandbox({
        environment_vars: { ELIZAOS_API_KEY: "eliza_cloud_key" },
      }),
    );
    const cloudKeyOnly = await request(
      `/api/v1/eliza/agents/${AGENT}/api/status`,
    );
    expect(cloudKeyOnly.status).toBe(503);
    expect(await readJson(cloudKeyOnly)).toMatchObject({
      code: "agent_unavailable",
    });

    sandboxes.set(
      AGENT,
      runningSandbox({ health_url: "https://attacker.example/api/health" }),
    );
    const remoteHost = await request(
      `/api/v1/eliza/agents/${AGENT}/api/status`,
    );
    expect(remoteHost.status).toBe(503);
    expect(await readJson(remoteHost)).toMatchObject({
      code: "agent_unavailable",
    });
    expect(upstreamCalls).toEqual([]);
  });

  test("swaps the Cloud credential for the runtime token and forwards the exact path", async () => {
    sandboxes.set(AGENT, runningSandbox());
    upstreamResponse = () =>
      new Response(JSON.stringify({ from: "runtime" }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "set-cookie": "runtime=1; HttpOnly",
          "x-runtime": "yes",
        },
      });
    const response = await request(
      `/api/v1/eliza/agents/${AGENT}/api/conversations/conv%201/messages?limit=5&after=x`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer eliza_cloud_session",
          Cookie: "session=browser",
          "X-API-Key": "eliza_cloud_key",
          "X-Eliza-Csrf": "token",
          "Content-Type": "application/json",
          Origin: "http://localhost:5173",
        },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    expect(response.status).toBe(201);
    expect(await readJson(response)).toEqual({ from: "runtime" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-runtime")).toBe("yes");
    expect(response.headers.get("x-test-cors")).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );

    expect(upstreamCalls).toHaveLength(1);
    const [call] = upstreamCalls;
    expect(call.url).toBe(
      `${RUNTIME_ORIGIN}/api/conversations/conv%201/messages?limit=5&after=x`,
    );
    expect(call.method).toBe("POST");
    expect(call.body).toBe(JSON.stringify({ text: "hello" }));
    expect(call.headers.authorization).toBe("Bearer agent-token-1");
    expect(call.headers.cookie).toBeUndefined();
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.headers["x-eliza-csrf"]).toBeUndefined();
    expect(call.headers["content-type"]).toBe("application/json");
    // The Cloud host must not ride along; fetch derives Host from the target.
    expect(call.headers.host).toBeUndefined();
  });

  test("serves the health sibling from the runtime instead of the Shared resolver", async () => {
    sandboxes.set(AGENT, runningSandbox());
    upstreamResponse = () =>
      Response.json({ status: "ok", runtime: "dedicated" }, { status: 200 });
    const response = await request(`/api/v1/eliza/agents/${AGENT}/api/health`);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      status: "ok",
      runtime: "dedicated",
    });
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      `${RUNTIME_ORIGIN}/api/health`,
    ]);
    expect(resolveSharedAgentCalls).toBe(0);

    sandboxes.clear();
    const shared = await request(`/api/v1/eliza/agents/${AGENT}/api/health`);
    expect(shared.status).toBe(404);
    expect(resolveSharedAgentCalls).toBe(1);
  });

  test("preserves an agent-scoped loopback bridge path", async () => {
    const bridgeBase = `${RUNTIME_ORIGIN}/api/compat/agents/sandbox-1`;
    sandboxes.set(
      AGENT,
      runningSandbox({
        bridge_url: bridgeBase,
      }),
    );
    const response = await request(
      `/api/v1/eliza/agents/${AGENT}/api/conversations/conv-1/messages`,
    );
    expect(response.status).toBe(200);
    expect(upstreamCalls.map((call) => call.url)).toEqual([
      `${bridgeBase}/api/conversations/conv-1/messages`,
    ]);
  });

  test("answers preflight locally without touching the runtime", async () => {
    sandboxes.set(AGENT, runningSandbox());
    const response = await request(`/api/v1/eliza/agents/${AGENT}/api/status`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-test-cors")).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(lookups).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });
});
