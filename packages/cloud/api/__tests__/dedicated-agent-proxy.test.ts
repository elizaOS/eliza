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
import { runInNewContext } from "node:vm";
import * as agentSandboxesActual from "@/db/repositories/agent-sandboxes";
import { AuthenticationError, ForbiddenError } from "@/lib/api/errors";
import * as authActual from "@/lib/auth";
import * as cloudBindingsActual from "@/lib/runtime/cloud-bindings";
import * as billingGateActual from "@/lib/services/agent-billing-gate";
import * as pairingTokenActual from "@/lib/services/pairing-token";
import * as provisioningJobsActual from "@/lib/services/provisioning-jobs";
import * as workerHealthActual from "@/lib/services/provisioning-worker-health";
import * as loggerActual from "@/lib/utils/logger";

let authResult:
  | { user: { id: string; organization_id: string } }
  | "throw"
  | "forbidden"
  | "unexpected" = "throw";
let sandboxResult: Record<string, unknown> | null = null;
let creditGateResult: { allowed: boolean; balance: number; error?: string } = {
  allowed: true,
  balance: 100,
};
let enqueueCalls = 0;
type BrowserClaim =
  | {
      status: "claimed";
      apiKey: string;
      agentName: string | null;
      pairingToken: { agentId: string };
    }
  | { status: "invalid" }
  | { status: "sandbox-credential-unavailable" };
let browserClaimResult: BrowserClaim = { status: "invalid" };
let browserClaimError: Error | null = null;
const browserClaimCalls: Array<{
  token: string;
  binding: { agentId: string; expectedOrigin: string };
}> = [];
const authRequests: Request[] = [];

mock.module("@/lib/runtime/cloud-bindings", () => ({
  ...cloudBindingsActual,
  runWithCloudBindingsAsync: (_b: unknown, fn: () => Promise<unknown>) => fn(),
}));
mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: async (request: Request) => {
    authRequests.push(request);
    if (authResult === "throw") throw new AuthenticationError("unauthorized");
    if (authResult === "forbidden") throw new ForbiddenError("forbidden");
    if (authResult === "unexpected") throw new Error("auth dependency failed");
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
mock.module("@/lib/services/pairing-token", () => ({
  ...pairingTokenActual,
  getPairingTokenService: () => ({
    claimBrowserToken: async (
      token: string,
      binding: { agentId: string; expectedOrigin: string },
    ) => {
      browserClaimCalls.push({ token, binding });
      if (browserClaimError) throw browserClaimError;
      return browserClaimResult;
    },
  }),
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
function requireCapturedRequest(): Request {
  if (!captured) throw new Error("origin request was not captured");
  return captured;
}
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
  mock.module("@/lib/services/pairing-token", () => pairingTokenActual);
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
const PAIR_TOKEN = "A".repeat(43);
let rateLimitResult = { success: true };
let rateLimitError: Error | null = null;
const rateLimitKeys: string[] = [];
const ENV = {
  AGENT_ROUTER_ORIGIN_HOST: "cp.example.test",
  GLOBAL_RATE_LIMITER: {
    limit: async ({ key }: { key: string }) => {
      rateLimitKeys.push(key);
      if (rateLimitError) throw rateLimitError;
      return rateLimitResult;
    },
  },
} as never;

function makeRequest(
  cloudToken?: string,
  origin?: string,
  extraHeaders?: HeadersInit,
  pathname = "/api/status",
): Request {
  const headers = new Headers(extraHeaders);
  if (cloudToken) headers.set("authorization", `Bearer ${cloudToken}`);
  if (origin) headers.set("origin", origin);
  return new Request(`https://${AGENT}.elizacloud.ai${pathname}`, { headers });
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
  browserClaimResult = { status: "invalid" };
  browserClaimError = null;
  browserClaimCalls.length = 0;
  authRequests.length = 0;
  rateLimitResult = { success: true };
  rateLimitError = null;
  rateLimitKeys.length = 0;
});

function executePairHandoff(html: string): {
  localValues: Map<string, string>;
  replaceCalls: string[];
  sessionValues: Map<string, string>;
  windowObject: Record<PropertyKey, unknown>;
} {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script)
    throw new Error("Managed pairing handoff script was not rendered.");

  const localValues = new Map<string, string>();
  const sessionValues = new Map<string, string>();
  const replaceCalls: string[] = [];
  const storage = (values: Map<string, string>) => ({
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  });
  const windowObject: Record<PropertyKey, unknown> = {
    localStorage: storage(localValues),
    sessionStorage: storage(sessionValues),
    location: {
      hostname: `${AGENT}.elizacloud.ai`,
      protocol: "https:",
      replace: (value: string) => replaceCalls.push(value),
    },
  };
  runInNewContext(script, {
    window: windowObject,
    document: { querySelector: () => ({ textContent: "" }) },
    console: { error() {} },
  });
  return { localValues, replaceCalls, sessionValues, windowObject };
}

describe("dedicated-agent-proxy — edge-owned managed pairing", () => {
  test("claims the production URL identity at the edge and installs only the scoped browser handoff", async () => {
    const apiKey = `agent_a"</script><script>alert(1)</script>`;
    browserClaimResult = {
      status: "claimed",
      apiKey,
      agentName: "Nova",
      pairingToken: { agentId: AGENT },
    };
    const request = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
      { headers: { "cf-connecting-ip": "203.0.113.15" } },
    );

    const response = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(captured).toBeNull();
    expect(rateLimitKeys).toEqual(["managed-pair:203.0.113.15"]);
    expect(browserClaimCalls).toEqual([
      {
        token: PAIR_TOKEN,
        binding: {
          agentId: AGENT,
          expectedOrigin: `https://${AGENT}.elizacloud.ai`,
        },
      },
    ]);

    const html = await response.text();
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const handoff = executePairHandoff(html);
    const scopedKey = `eliza:cloud-pair:api-token:${AGENT}`;
    expect(handoff.localValues.get(scopedKey)).toBe(apiKey);
    expect(handoff.sessionValues.get(scopedKey)).toBe(apiKey);
    expect(handoff.localValues.has("eliza:cloud-pair:api-token")).toBe(false);
    expect(
      handoff.localValues.has("eliza:cloud-pair:local-owner-agent-id"),
    ).toBe(false);
    expect(
      handoff.sessionValues.has("eliza:cloud-pair:local-owner-agent-id"),
    ).toBe(false);
    expect(handoff.replaceCalls).toEqual(["/"]);
    expect(
      (
        handoff.windowObject.__ELIZAOS_APP_BOOT_CONFIG__ as {
          apiToken?: string;
        }
      ).apiToken,
    ).toBe(apiKey);
  });

  test("binds staging claims to the staging agent origin and never proxies invalid claims", async () => {
    browserClaimResult = { status: "invalid" };
    const request = new Request(
      `https://${AGENT}.staging.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
      { headers: { "cf-connecting-ip": "198.51.100.8" } },
    );

    const response = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Sign-in link expired");
    expect(browserClaimCalls[0]?.binding).toEqual({
      agentId: AGENT,
      expectedOrigin: `https://${AGENT}.staging.elizacloud.ai`,
    });
    expect(captured).toBeNull();
  });

  test("rejects malformed tokens and non-GET requests before any claim or proxy", async () => {
    const malformed = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=short`,
    );
    const malformedResponse = await handleDedicatedAgentProxy(
      malformed,
      ENV,
      urlOf(malformed),
      AGENT,
    );
    expect(malformedResponse.status).toBe(400);

    const post = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
      { method: "POST" },
    );
    const postResponse = await handleDedicatedAgentProxy(
      post,
      ENV,
      urlOf(post),
      AGENT,
    );
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toBe("GET");

    const options = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
      { method: "OPTIONS", headers: { origin: "https://attacker.example" } },
    );
    const optionsResponse = await handleDedicatedAgentProxy(
      options,
      ENV,
      urlOf(options),
      AGENT,
    );
    expect(optionsResponse.status).toBe(405);
    expect(
      optionsResponse.headers.get("access-control-allow-origin"),
    ).toBeNull();
    expect(browserClaimCalls).toHaveLength(0);
    expect(captured).toBeNull();
  });

  test("fails closed when the native rate limiter denies, throws, or is absent", async () => {
    const request = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
    );

    rateLimitResult = { success: false };
    const denied = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");

    rateLimitResult = { success: true };
    rateLimitError = new Error("binding unavailable");
    const failed = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );
    expect(failed.status).toBe(503);

    const missing = await handleDedicatedAgentProxy(
      request,
      { AGENT_ROUTER_ORIGIN_HOST: "cp.example.test" } as never,
      urlOf(request),
      AGENT,
    );
    expect(missing.status).toBe(503);
    expect(browserClaimCalls).toHaveLength(0);
    expect(captured).toBeNull();
  });

  test("surfaces credential and storage failures without forwarding the one-time token", async () => {
    const request = new Request(
      `https://${AGENT}.elizacloud.ai/pair?token=${PAIR_TOKEN}`,
    );

    browserClaimResult = { status: "sandbox-credential-unavailable" };
    const missingCredential = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );
    expect(missingCredential.status).toBe(503);

    browserClaimError = new Error("database unavailable");
    const storageFailure = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );
    expect(storageFailure.status).toBe(500);
    expect(captured).toBeNull();
  });
});

describe("dedicated-agent-proxy — unified auth", () => {
  test("validated OWNER of a RUNNING agent → injects the agent token, strips the cloud token, targets the CP", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;

    const r = makeRequest(
      "cloud-token-abc",
      "https://app-staging.elizacloud.ai",
      {
        cookie:
          "steward-token=cloud-session; steward-refresh-token=cloud-refresh",
        "cf-access-client-secret": "cloudflare-access-secret",
        "x-api-key": "cloud-api-key",
        "x-cron-secret": "cloud-cron-secret",
        "x-eliza-service-token": "cloud-agent-service-token",
        "x-internal-token": "cloud-internal-token",
        "x-service-key": "cloud-service-key",
        "x-service-token": "cloud-service-token",
        "x-steward-signer-secret": "steward-signer-secret",
        "x-timestamp": "1234567890",
        "x-wallet-address": "0xcloud-wallet",
        "x-wallet-signature": "cloud-wallet-signature",
      },
    );
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(200);
    expect(authRequests).toHaveLength(1);
    expect(authRequests[0]?.headers.get("cookie")).toBeNull();
    expect(captured).not.toBeNull();
    // The container gets the agent's own token, NOT the cloud token.
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
    expect(captured?.headers.get("x-api-key")).toBeNull();
    expect(captured?.headers.get("cookie")).toBeNull();
    expect(captured?.headers.get("cf-access-client-secret")).toBeNull();
    expect(captured?.headers.get("x-cron-secret")).toBeNull();
    expect(captured?.headers.get("x-eliza-service-token")).toBeNull();
    expect(captured?.headers.get("x-internal-token")).toBeNull();
    expect(captured?.headers.get("x-service-key")).toBeNull();
    expect(captured?.headers.get("x-service-token")).toBeNull();
    expect(captured?.headers.get("x-steward-signer-secret")).toBeNull();
    expect(captured?.headers.get("x-timestamp")).toBeNull();
    expect(captured?.headers.get("x-wallet-address")).toBeNull();
    expect(captured?.headers.get("x-wallet-signature")).toBeNull();
    expect(new URL(captured?.url ?? "").hostname).toBe("cp.example.test");
    // withCors backfills the browser Origin even though the mocked upstream
    // ("ok") carried none, so the proxied response is never CORS-opaque (#15347).
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app-staging.elizacloud.ai",
    );
  });

  test("NO cloud token → passes through cookie-free (never injects the agent token)", async () => {
    authResult = "throw";
    const r = makeRequest(undefined, undefined, {
      cookie:
        "steward-token=expired-session; steward-refresh-token=live-refresh",
    });
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(authRequests).toHaveLength(1);
    expect(authRequests[0]?.headers.get("cookie")).toBeNull();
    expect(captured?.headers.get("authorization")).toBeNull();
    expect(captured?.headers.get("cookie")).toBeNull();
  });

  test("rejected Cloud auth preserves an agent-local bearer but strips Cloud cookies", async () => {
    authResult = "throw";
    const r = makeRequest("agent_local_token", undefined, {
      "cf-access-jwt-assertion": "cloudflare-access-jwt",
      cookie: "steward-refresh-token=cloud-refresh",
      "x-api-token": "agent_api_token",
      "x-elizaos-token": "agent_elizaos_token",
      "x-internal-token": "cloud-internal-token",
      "x-service-key": "cloud-service-key",
      "x-steward-key": "steward-key",
      "x-timestamp": "1234567890",
      "x-wallet-address": "0xcloud-wallet",
      "x-wallet-signature": "cloud-wallet-signature",
    });
    await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent_local_token",
    );
    expect(captured?.headers.get("cookie")).toBeNull();
    expect(captured?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(captured?.headers.get("x-internal-token")).toBeNull();
    expect(captured?.headers.get("x-service-key")).toBeNull();
    expect(captured?.headers.get("x-steward-key")).toBeNull();
    expect(captured?.headers.get("x-timestamp")).toBeNull();
    expect(captured?.headers.get("x-wallet-address")).toBeNull();
    expect(captured?.headers.get("x-wallet-signature")).toBeNull();
    expect(captured?.headers.get("x-api-token")).toBe("agent_api_token");
    expect(captured?.headers.get("x-elizaos-token")).toBe(
      "agent_elizaos_token",
    );
  });

  test("rejected Cloud-shaped credentials fail at the edge instead of reaching the container", async () => {
    authResult = "throw";
    const cloudCredentialHeaders: HeadersInit[] = [
      { authorization: "Bearer eliza_cloud_api_key" },
      { authorization: "Bearer header.payload.signature" },
      { "x-api-key": "eliza_cloud_api_key" },
    ];
    for (const headers of cloudCredentialHeaders) {
      captured = null;
      const r = makeRequest(undefined, undefined, headers);
      const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "cloud_auth_rejected" });
      expect(captured).toBeNull();
    }
  });

  test("authenticated NON-OWNER bearer → 403 at the edge and no credential reaches the container", async () => {
    authResult = { user: { id: "att", organization_id: "attacker-org" } };
    sandboxResult = null; // attacker's org does not own this agent
    const r = makeRequest("attacker-cloud-token", undefined, {
      cookie: "steward-refresh-token=attacker-refresh",
    });
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "agent_access_denied" });
    expect(captured).toBeNull();
  });

  test("authenticated NON-OWNER API key → 403 at the edge and no key reaches the container", async () => {
    authResult = { user: { id: "att", organization_id: "attacker-org" } };
    sandboxResult = null;
    const r = makeRequest(undefined, undefined, {
      "x-api-key": "valid-cloud-api-key",
    });
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(403);
    expect(captured).toBeNull();
  });

  test("shared-tier row on a dedicated host → 403 at the edge, no injection", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = {
      ...runningDedicated,
      execution_tier: "shared",
    };
    const r = makeRequest("cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(403);
    expect(captured).toBeNull();
  });

  test("static asset pass-through strips parent-domain Cloud cookies", async () => {
    authResult = "throw";
    const r = makeRequest(
      undefined,
      undefined,
      {
        cookie:
          "steward-token=expired-session; steward-refresh-token=live-refresh",
      },
      "/assets/index.js",
    );
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(new URL(captured?.url ?? "").pathname).toBe("/assets/index.js");
    expect(captured?.headers.get("cookie")).toBeNull();
  });

  test("unexpected Cloud auth failure fails at the edge instead of forwarding a possibly valid credential", async () => {
    authResult = "unexpected";
    const r = makeRequest("possibly-valid-cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "cloud_auth_unavailable" });
    expect(captured).toBeNull();
  });

  test("validated owner with no agent credential fails at the edge", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = {
      ...runningDedicated,
      environment_vars: {},
    };
    const r = makeRequest("cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "agent_credential_unavailable",
    });
    expect(captured).toBeNull();
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

  test("owner of a terminal-error agent receives a machine-readable 503 without a resume", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = { ...runningDedicated, status: "error" };
    const r = makeRequest("cloud-token", "https://app-staging.elizacloud.ai");

    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      code: "agent_error_state",
      data: { status: "error" },
    });
    expect(enqueueCalls).toBe(0);
    expect(captured).toBeNull();
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
    const sent: string[] = [];
    const socket = {
      send(value: string) {
        sent.push(value);
      },
    } satisfies Pick<WebSocket, "send">;
    fetchImpl = async () => {
      const response = new Response(null, {
        status: 101,
        headers: {
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": "https://attacker.example",
          "set-cookie": "steward-token=attacker; Domain=elizacloud.ai",
        },
      });
      Object.defineProperty(response, "webSocket", { value: socket });
      return response;
    };

    const r = makeWsRequest("cloud-token-abc");
    const response = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(captured).not.toBeNull();
    expect(new URL(captured?.url ?? "").searchParams.get("token")).toBe(
      "agent-secret-token",
    );
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
    expect(response.status).toBe(101);
    const returnedSocket: unknown = Reflect.get(response, "webSocket");
    expect(returnedSocket).toBe(socket);
    if (
      !returnedSocket ||
      typeof returnedSocket !== "object" ||
      !("send" in returnedSocket) ||
      typeof returnedSocket.send !== "function"
    ) {
      throw new Error(
        "proxied WebSocket response did not expose a usable endpoint",
      );
    }
    returnedSocket.send("ping");
    expect(sent).toEqual(["ping"]);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("invalid upstream WebSocket upgrade without an endpoint fails closed", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;
    fetchImpl = async () => new Response(null, { status: 101 });

    const r = makeWsRequest("cloud-token-abc");
    const response = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(response.status).toBe(502);
  });

  test("rejected Cloud-shaped WS query token fails at the edge", async () => {
    authResult = "throw";
    const r = makeWsRequest("eliza_cloud_api_key");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(401);
    expect(captured).toBeNull();
  });

  test("validated header auth strips every query credential alias before proxying", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;
    const u = new URL(`https://${AGENT}.elizacloud.ai/ws`);
    u.searchParams.append("token", "eliza_query_secret");
    u.searchParams.append("apiKey", "header.payload.signature");
    u.searchParams.append("api_key", "another-query-secret");
    const r = new Request(u, {
      headers: { authorization: "Bearer valid-cloud-header" },
    });

    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(200);
    const proxiedUrl = new URL(captured?.url ?? "");
    expect(proxiedUrl.searchParams.getAll("token")).toEqual([]);
    expect(proxiedUrl.searchParams.getAll("apiKey")).toEqual([]);
    expect(proxiedUrl.searchParams.getAll("api_key")).toEqual([]);
    expect(captured?.headers.get("authorization")).toBe(
      "Bearer agent-secret-token",
    );
  });

  test("Cloud-shaped query credentials cannot hide behind rejected agent-local headers", async () => {
    authResult = "throw";
    const u = new URL(`https://${AGENT}.elizacloud.ai/ws`);
    u.searchParams.set("apiKey", "eliza_cloud_query_secret");
    const r = new Request(u, {
      headers: { authorization: "Bearer agent_local_header" },
    });

    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "cloud_auth_rejected" });
    expect(captured).toBeNull();
  });

  test("query-only apiKey aliases are validated and rewritten in the same slot", async () => {
    authResult = { user: { id: "u1", organization_id: "org1" } };
    sandboxResult = runningDedicated;

    for (const alias of ["apiKey", "api_key"] as const) {
      captured = null;
      const u = new URL(`https://${AGENT}.elizacloud.ai/ws`);
      u.searchParams.set(alias, "cloud-query-token");
      const res = await handleDedicatedAgentProxy(
        new Request(u),
        ENV,
        u,
        AGENT,
      );

      expect(res.status).toBe(200);
      const proxiedUrl = new URL(requireCapturedRequest().url);
      expect(proxiedUrl.searchParams.get(alias)).toBe("agent-secret-token");
      for (const other of ["token", "apiKey", "api_key"]) {
        if (other !== alias)
          expect(proxiedUrl.searchParams.get(other)).toBeNull();
      }
    }
  });

  test("duplicate query credentials are all inspected before agent-local fallback", async () => {
    authResult = "throw";
    const u = new URL(`https://${AGENT}.elizacloud.ai/ws`);
    u.searchParams.append("token", "agent_local_token");
    u.searchParams.append("token", "eliza_cloud_query_secret");

    const res = await handleDedicatedAgentProxy(new Request(u), ENV, u, AGENT);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "cloud_auth_rejected" });
    expect(captured).toBeNull();
  });

  test("WS ?token= from a NON-OWNER → 403 at the edge and token never reaches the container", async () => {
    authResult = { user: { id: "att", organization_id: "attacker-org" } };
    sandboxResult = null; // attacker's org does not own this agent

    const r = makeWsRequest("attacker-cloud-token");
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);
    expect(res.status).toBe(403);
    expect(captured).toBeNull();
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
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(captured).toBeNull(); // preflight is answered at the edge
  });

  test("no-Origin responses still vary on Origin for shared caches", async () => {
    authResult = "throw";
    const r = new Request(`https://${AGENT}.elizacloud.ai/assets/app.js`);
    const res = await handleDedicatedAgentProxy(r, ENV, urlOf(r), AGENT);

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
  });

  test("tenant agent origins cannot preflight or call another agent", async () => {
    const attackerOrigin =
      "https://22222222-2222-2222-2222-222222222222.elizacloud.ai";
    const preflight = new Request(`https://${AGENT}.elizacloud.ai/api/status`, {
      method: "OPTIONS",
      headers: { origin: attackerOrigin },
    });
    const deniedPreflight = await handleDedicatedAgentProxy(
      preflight,
      ENV,
      urlOf(preflight),
      AGENT,
    );
    expect(deniedPreflight.status).toBe(403);
    expect(
      deniedPreflight.headers.get("access-control-allow-origin"),
    ).toBeNull();

    const request = makeRequest("victim-cloud-token", attackerOrigin, {
      cookie: "steward-token=victim-session",
    });
    const denied = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );
    expect(denied.status).toBe(403);
    expect(authRequests).toHaveLength(0);
    expect(captured).toBeNull();
  });

  test("the Worker replaces tenant response policy and strips parent-domain state mutation", async () => {
    authResult = "throw";
    fetchImpl = async () =>
      new Response("ok", {
        headers: {
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": "https://attacker.example",
          "clear-site-data": '"cookies"',
          "set-cookie":
            "steward-token=attacker; Domain=elizacloud.ai; Secure; HttpOnly",
          "set-cookie2": "legacy=attacker; Domain=elizacloud.ai",
          vary: "Accept-Encoding",
        },
      });

    const request = makeRequest(undefined, ORIGIN);
    const response = await handleDedicatedAgentProxy(
      request,
      ENV,
      urlOf(request),
      AGENT,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("set-cookie2")).toBeNull();
    expect(response.headers.get("clear-site-data")).toBeNull();
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(response.headers.get("vary")).toContain("Origin");
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
