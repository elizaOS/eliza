/**
 * Verifies dedicated-agent proxy ownership, token isolation, runtime recovery,
 * and headers-phase timeout behavior with deterministic Worker fixtures.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as agentSandboxesActual from "@/db/repositories/agent-sandboxes";
import * as authActual from "@/lib/auth";
import * as cloudBindingsActual from "@/lib/runtime/cloud-bindings";
import * as billingGateActual from "@/lib/services/agent-billing-gate";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as workerHealthActual from "@/lib/services/provisioning-worker-health";
import * as loggerActual from "@/lib/utils/logger";

let authResult: { user: { id: string; organization_id: string } } | "throw" =
  "throw";
let sandboxResult: Record<string, unknown> | null = null;
let creditGateResult: { allowed: boolean; balance: number; error?: string } = {
  allowed: true,
  balance: 100,
};
let enqueueCalls = 0;

mock.module("@/lib/runtime/cloud-bindings", () => ({
  ...cloudBindingsActual,
  runWithCloudBindingsAsync: (_b: unknown, fn: () => Promise<unknown>) => fn(),
}));
mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: async () => {
    if (authResult === "throw") throw new Error("unauthorized");
    return authResult;
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  ...agentSandboxesActual,
  agentSandboxesRepository: {
    ...agentSandboxesActual.agentSandboxesRepository,
    findByIdAndOrg: async () => sandboxResult,
  },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  ...provisioningJobsActual,
  provisioningJobService: {
    ...provisioningJobsActual.provisioningJobService,
    enqueueAgentProvisionOnce: async () => {
      enqueueCalls++;
      return {
        job: { id: "job-1" },
        created: true,
      };
    },
  },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  ...workerHealthActual,
  checkProvisioningWorkerHealth: async () => ({ ok: true }),
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  ...billingGateActual,
  checkAgentCreditGate: async () => creditGateResult,
}));
mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    ...loggerActual.logger,
    warn() {},
    error() {},
    info() {},
    debug() {},
  },
}));

let captured: Request | null = null;
// Per-test override for the origin fetch; null = the default instant-200 stub.
let fetchImpl: ((request: Request) => Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const request = input instanceof Request ? input : new Request(input);
  captured = request;
  if (fetchImpl) return fetchImpl(request);
  return new Response("ok", { status: 200 });
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
  mock.module("@/lib/runtime/cloud-bindings", () => cloudBindingsActual);
  mock.module("@/lib/auth", () => authActual);
  mock.module("@/db/repositories/agent-sandboxes", () => agentSandboxesActual);
  mock.module("@/lib/services/agent-billing-gate", () => billingGateActual);
  mock.module("@/lib/services/provisioning-jobs", () => provisioningJobsActual);
  mock.module(
    "@/lib/services/provisioning-worker-health",
    () => workerHealthActual,
  );
  mock.module("@/lib/utils/logger", () => loggerActual);
});

const {
  handleDedicatedAgentProxy,
  dedicatedProxyOriginHeadersTimeoutMs,
  __dedicatedProxyTestHooks,
} = await import("../src/dedicated-agent-proxy");

const AGENT = "11111111-1111-1111-1111-111111111111";
const ENV = { AGENT_ROUTER_ORIGIN_HOST: "cp.example.test" } as never;

function makeRequest(cloudToken?: string, origin?: string): Request {
  const headers = new Headers();
  if (cloudToken) headers.set("authorization", `Bearer ${cloudToken}`);
  if (origin) headers.set("origin", origin);
  return new Request(`https://${AGENT}.elizacloud.ai/api/status`, { headers });
}
const urlOf = (r: Request) => new URL(r.url);

// A running row carries a mesh IP once it has joined headscale; without it the
// proxy short-circuits (running-but-unroutable, #15347), so the happy-path
// fixture pins one to prove the token-swap path still routes.
const runningDedicated = {
  id: AGENT,
  execution_tier: "dedicated-always",
  status: "running",
  headscale_ip: "100.64.0.21",
  environment_vars: { ELIZA_API_TOKEN: "agent-secret-token" },
  agent_name: "qa",
  updated_at: new Date(),
};

beforeEach(() => {
  captured = null;
  fetchImpl = null;
  authResult = "throw";
  sandboxResult = null;
  creditGateResult = { allowed: true, balance: 100 };
  enqueueCalls = 0;
});

describe("dedicated-agent-proxy — unified auth", () => {
  test("validated OWNER of a RUNNING agent → injects the agent token, strips the cloud token, targets the CP", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;

    const r = makeRequest(
      "cloud-token-abc",
      "https://app-staging.elizacloud.ai",
    );
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // The container gets the agent's own token, NOT the cloud token.
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
    expect(captured?.headers.get("x-api-key")).toBeNull();
    expect(new URL(captured?.url ?? "").hostname).toBe("cp.example.test");
    // withCors backfills the browser Origin even though the mocked upstream
    // ("ok") carried none, so the proxied response is never CORS-opaque (#15347).
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app-staging.elizacloud.ai",
    );
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
    const r = makeRequest("cloud-token", "https://app-staging.elizacloud.ai");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(captured).toBeNull();
    // Regression: the 202 previously bypassed CORS entirely (this handler is
    // mounted before Hono's cors middleware), so the browser could not read it.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app-staging.elizacloud.ai",
    );
  });

  test("owner of a NON-RUNNING agent WITH sufficient credits → 202 and enqueues the resume (#11583)", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, status: "stopped" };
    creditGateResult = { allowed: true, balance: 100 };
    const r = makeRequest("cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(202);
    expect(enqueueCalls).toBe(1); // paying org is not blocked
  });

  test("owner of a SUSPENDED / zero-balance agent → 402 and NO re-provision (free-compute suspension bypass closed, #11583)", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    // active-billing suspends a non-paying org's agent to `stopped`; without the
    // gate, hitting the agent subdomain would re-provision it for free.
    sandboxResult = { ...runningDedicated, status: "stopped" };
    creditGateResult = {
      allowed: false,
      balance: 0,
      error: "Insufficient credits.",
    };
    const r = makeRequest("cloud-token", "https://app-staging.elizacloud.ai");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(402);
    // Regression: browser-visible billing failure must carry CORS (#15347).
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app-staging.elizacloud.ai",
    );
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("insufficient_credits");
    expect(enqueueCalls).toBe(0); // no free compute
    expect(captured).toBeNull(); // nothing proxied to the container
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

/**
 * The demo show-stopper (#15347): a staging agent is `running` but never joined
 * headscale, so `headscale_ip` is empty and the CP returns a CORS-less 404 the
 * browser reads as an opaque CORS error. The proxy must (a) answer preflights,
 * (b) short-circuit the doomed CP round-trip with a readable 503, and (c)
 * guarantee CORS on every browser-visible response.
 */
describe("dedicated-agent-proxy — CORS + unroutable short-circuit (#15347)", () => {
  const ORIGIN = "https://app-staging.elizacloud.ai";

  test("OPTIONS preflight → 204 + reflected CORS, no auth/DB/proxy work", async () => {
    authResult = "throw"; // even a total auth failure must not reach here
    const r = new Request(`https://${AGENT}.elizacloud.ai/api/status`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN },
    });
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(captured).toBeNull(); // preflight is answered at the edge
  });

  test("owner + running + EMPTY headscale_ip + fallback off → 503 agent_unroutable + CORS, no CP round-trip", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, headscale_ip: "" };

    const r = makeRequest("cloud-token", ORIGIN);
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await res.json()) as { code?: string; success?: boolean };
    expect(body.code).toBe("agent_unroutable");
    expect(body.success).toBe(false);
    // The whole point: never proxy a guaranteed CORS-less 404 to the CP.
    expect(captured).toBeNull();
  });

  test("owner + running + NULL headscale_ip → 503 (null is treated as empty)", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, headscale_ip: null };
    const r = makeRequest("cloud-token", ORIGIN);
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(503);
    expect(captured).toBeNull();
  });

  test("bridge-host fallback ON + running + empty ip → proxied, NOT short-circuited", async () => {
    // The CP can reach the agent via published host ports when the operator
    // opts into the fallback, so the worker must not pre-empt that with a 503.
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, headscale_ip: "" };
    const fallbackEnv = {
      AGENT_ROUTER_ORIGIN_HOST: "cp.example.test",
      AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
    } as never;

    const r = makeRequest("cloud-token", ORIGIN);
    const res = await handleDedicatedAgentProxy(
      r,
      fallbackEnv,
      urlOf(r),
      AGENT,
    );

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull(); // proxied to the CP
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
  });

  test("unauthenticated pass-through still gets CORS backfilled", async () => {
    // No valid token → pass through to the CP unchanged; the CP has no CORS, so
    // withCors must still backfill it or the browser sees an opaque failure.
    authResult = "throw";
    const r = makeRequest(undefined, ORIGIN);
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(captured).not.toBeNull(); // forwarded to the CP
  });
});

/**
 * Stream-aware origin timeout. The old `AbortSignal.timeout(30s)` on the whole
 * fetch killed any body still flowing at t=30s — a >30s agent chat turn (or any
 * long SSE stream) surfaced to the client as an unhandled TimeoutError
 * (CF error 1101 / empty body) while the agent's reply persisted server-side.
 * The timeout must gate the HEADERS phase only: once a response starts, the
 * body flows for as long as the origin keeps it open, and a true
 * headers-timeout becomes a structured, retryable 504 the client can read.
 * Timeouts are shrunk to milliseconds via the test hook.
 */
describe("dedicated-agent-proxy — stream-aware origin timeout", () => {
  const ORIGIN = "https://app-staging.elizacloud.ai";
  const encoder = new TextEncoder();

  beforeEach(() => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;
  });
  afterEach(() => {
    __dedicatedProxyTestHooks.resetOriginHeadersTimeoutMs();
  });

  test("body still streaming PAST the headers timeout is not aborted — it completes", async () => {
    __dedicatedProxyTestHooks.setOriginHeadersTimeoutMs(50);

    fetchImpl = async (request) => {
      // Headers arrive well inside the timeout…
      await new Promise((resolve) => setTimeout(resolve, 10));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // The regression detector: if the proxy leaves its abort timer armed
          // after headers, the signal fires at t=50ms and errors the body
          // mid-stream (the old whole-transfer AbortSignal.timeout behavior).
          request.signal.addEventListener("abort", () => {
            try {
              controller.error(
                request.signal.reason ?? new Error("aborted mid-stream"),
              );
            } catch {
              // already closed — nothing to error
            }
          });
          controller.enqueue(encoder.encode("first-chunk "));
          // …but the body keeps flowing to 3x the headers timeout.
          setTimeout(() => {
            controller.enqueue(encoder.encode("late-chunk-past-timeout"));
            controller.close();
          }, 150);
        },
      });
      return new Response(body, { status: 200 });
    };

    const r = makeRequest("cloud-token", ORIGIN);
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(200);
    // Reading to completion is the assertion: the old behavior errors here.
    const text = await res.text();
    expect(text).toBe("first-chunk late-chunk-past-timeout");
  });

  test("origin exceeding the HEADERS timeout → structured 504 agent_timeout JSON, not a thrown TimeoutError", async () => {
    __dedicatedProxyTestHooks.setOriginHeadersTimeoutMs(20);

    // Origin never produces headers; a real fetch rejects when the signal aborts.
    fetchImpl = (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(
            request.signal.reason ??
              new DOMException("The operation timed out.", "TimeoutError"),
          ),
        );
      });

    const r = makeRequest("cloud-token", ORIGIN);
    // Old behavior: this await THROWS (client saw CF 1101 / empty body).
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(504);
    expect(res.headers.get("Retry-After")).toBe("5");
    // Browser-readable: CORS is backfilled on the error envelope (#15347).
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const body = (await res.json()) as { code?: string; success?: boolean };
    expect(body.success).toBe(false);
    expect(body.code).toBe("agent_timeout");
  });

  test("non-timeout fetch failures still propagate (fail-closed pass-through untouched)", async () => {
    __dedicatedProxyTestHooks.setOriginHeadersTimeoutMs(1_000);
    fetchImpl = async () => {
      throw new TypeError("connection refused");
    };

    const r = makeRequest("cloud-token", ORIGIN);
    // Not a headers timeout → the error is NOT swallowed into a 504.
    await expect(
      handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT),
    ).rejects.toThrow("connection refused");
  });
});

describe("dedicated-agent-proxy — workflow origin timeout budgets", () => {
  test("allows generation and clarification to reach the engine deadline", () => {
    expect(
      dedicatedProxyOriginHeadersTimeoutMs(
        "POST",
        "/api/workflow/workflows/generate",
      ),
    ).toBe(5 * 60_000);
    expect(
      dedicatedProxyOriginHeadersTimeoutMs(
        "POST",
        "/api/workflow/workflows/resolve-clarification/",
      ),
    ).toBe(5 * 60_000);
  });

  test("allows runs to reach the engine deadline without widening other routes", () => {
    expect(
      dedicatedProxyOriginHeadersTimeoutMs(
        "POST",
        "/api/workflow/workflows/workflow%2F1/run",
      ),
    ).toBe(10 * 60_000);
    expect(
      dedicatedProxyOriginHeadersTimeoutMs(
        "POST",
        "/api/workflow/workflows/workflow-1/activate",
      ),
    ).toBe(30_000);
    expect(
      dedicatedProxyOriginHeadersTimeoutMs(
        "GET",
        "/api/workflow/workflows/workflow-1/run",
      ),
    ).toBe(30_000);
  });
});
