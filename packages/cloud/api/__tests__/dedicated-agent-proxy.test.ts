import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Security tests for the dedicated-agent unified-auth proxy. The single
 * invariant under test: the agent's `ELIZA_API_TOKEN` is injected ONLY for a
 * validated owner of a RUNNING dedicated agent; every other path proxies
 * UNCHANGED (so the container's own auth stays the backstop).
 */

let authResult: { user: { id: string; organization_id: string } } | "throw" =
  "throw";
let sandboxResult: Record<string, unknown> | null = null;

mock.module("@/lib/runtime/cloud-bindings", () => ({
  runWithCloudBindingsAsync: (_b: unknown, fn: () => Promise<unknown>) => fn(),
}));
mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => {
    if (authResult === "throw") throw new Error("unauthorized");
    return authResult;
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg: async () => sandboxResult },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce: async () => ({
      job: { id: "job-1" },
      created: true,
    }),
  },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => ({ ok: true }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn() {}, error() {}, info() {}, debug() {} },
}));

let captured: Request | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  captured = input instanceof Request ? input : new Request(input);
  return new Response("ok", { status: 200 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

const { handleDedicatedAgentProxy } = await import(
  "../src/dedicated-agent-proxy"
);

const AGENT = "11111111-1111-1111-1111-111111111111";
const ENV = { AGENT_ROUTER_ORIGIN_HOST: "cp.example.test" } as never;

function makeRequest(cloudToken?: string): Request {
  const headers = new Headers();
  if (cloudToken) headers.set("authorization", `Bearer ${cloudToken}`);
  return new Request(`https://${AGENT}.elizacloud.ai/api/status`, { headers });
}
const urlOf = (r: Request) => new URL(r.url);

const runningDedicated = {
  id: AGENT,
  execution_tier: "dedicated-always",
  status: "running",
  environment_vars: { ELIZA_API_TOKEN: "agent-secret-token" },
  agent_name: "qa",
  updated_at: new Date(),
};

beforeEach(() => {
  captured = null;
  authResult = "throw";
  sandboxResult = null;
});

describe("dedicated-agent-proxy — unified auth", () => {
  test("validated OWNER of a RUNNING agent → injects the agent token, strips the cloud token, targets the CP", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;

    const r = makeRequest("cloud-token-abc");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // The container gets the agent's own token, NOT the cloud token.
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
    expect(captured?.headers.get("x-api-key")).toBeNull();
    expect(new URL(captured?.url ?? "").hostname).toBe("cp.example.test");
  });

  test("NO cloud token → pass through unchanged (never injects the agent token)", async () => {
    authResult = "throw";
    const r = makeRequest();
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(captured?.headers.get("authorization")).toBeNull();
  });

  test("authenticated NON-OWNER (findByIdAndOrg → null) → pass through, agent token NEVER injected", async () => {
    authResult = { user: { id: "att", organization_id: "attacker-org" } };
    sandboxResult = null; // attacker's org does not own this agent
    const r = makeRequest("attacker-cloud-token");
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    // forwarded verbatim — the container's own auth rejects it; the secret leaks nowhere
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer attacker-cloud-token",
    );
  });

  test("shared-tier agent → pass through, no injection", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = {
      ...runningDedicated,
      execution_tier: "shared",
    };
    const r = makeRequest("cloud-token");
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(captured?.headers.get("authorization")).toBe("Bearer cloud-token");
  });

  test("owner of a NON-RUNNING agent → 202 resume, does NOT proxy to the container", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, status: "stopped" };
    const r = makeRequest("cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(captured).toBeNull();
  });

  // A browser `new WebSocket()` can't set headers, so the app passes the cloud
  // token as `?token=`. The proxy must validate it the same way and rewrite it
  // to the agent token (the container reads `?token=` via ELIZA_ALLOW_WS_QUERY_TOKEN).
  function makeWsRequest(cloudToken?: string): Request {
    const u = new URL(`https://${AGENT}.elizacloud.ai/ws`);
    if (cloudToken) u.searchParams.set("token", cloudToken);
    return new Request(u.toString()); // no Authorization header
  }

  test("WS upgrade with ?token= (owner, running) → rewrites ?token= to the agent token + sets header", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;

    const r = makeWsRequest("cloud-token-abc");
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(captured).not.toBeNull();
    expect(new URL(captured?.url ?? "").searchParams.get("token")).toBe(
      "agent-secret-token",
    );
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
  });

  test("WS ?token= from a NON-OWNER → pass through, ?token= NOT rewritten (agent token never leaks)", async () => {
    authResult = { user: { id: "att", organization_id: "attacker-org" } };
    sandboxResult = null; // attacker's org does not own this agent

    const r = makeWsRequest("attacker-cloud-token");
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(new URL(captured?.url ?? "").searchParams.get("token")).toBe(
      "attacker-cloud-token",
    );
  });
});
