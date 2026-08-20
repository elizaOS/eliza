/**
 * Authentication and proxy boundary for dedicated-agent subdomains.
 *
 * Managed browser pairing terminates here and atomically binds the one-time
 * token to the URL agent and origin. Ordinary requests validate Cloud auth and
 * ownership, then swap it for the owned container credential.
 *
 * SECURITY — Cloud credentials terminate at this boundary. Parent-domain Cloud
 * cookies are stripped from every origin request. A rejected credential may be
 * an agent-local token and passes through to the container's own auth, but a
 * validated Cloud principal is either swapped to the owned agent credential or
 * rejected at the edge. This prevents a different tenant's container from
 * harvesting a visitor's Cloud session, API key, or bearer.
 *
 * Lazy-imported from `index.ts` only on a UUID-subdomain request, so the Worker
 * entrypoint stays thin (Cloudflare startup-CPU budget).
 */

import { renderCloudPairHandoffHtml } from "@elizaos/shared/contracts";
import {
  ELIZA_DOMAIN_CONTRACTS,
  elizaCloudEnvironmentForHostname,
} from "@elizaos/shared/elizacloud";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { AuthenticationError, ForbiddenError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { isFirstPartyOrigin } from "@/lib/cors/cloud-api-hono-cors";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { checkProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

type Bindings = AppEnv["Bindings"];

const DEFAULT_AGENT_ROUTER_ORIGIN_HOST = "eliza-production-1.eliza.app";

/** Non-`running` statuses we auto-resume on (mirrors the pairing endpoint). */
const RESUMABLE_STATUSES = new Set(["pending", "stopped", "disconnected"]);
const RETRY_AFTER_SECONDS = 5;
const DEFAULT_ORIGIN_HEADERS_TIMEOUT_MS = 30_000;
const WORKFLOW_GENERATION_HEADERS_TIMEOUT_MS = 5 * 60_000;
const WORKFLOW_RUN_HEADERS_TIMEOUT_MS = 10 * 60_000;
const MANAGED_PAIR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MANAGED_PAIR_RATE_LIMIT_RETRY_SECONDS = 60;
const CLOUD_ONLY_CREDENTIAL_HEADERS = [
  "cookie",
  "proxy-authorization",
  "x-bootstrap-secret",
  "x-cron-secret",
  "x-eliza-csrf",
  "x-eliza-service-token",
  "x-internal-token",
  "x-service-key",
  "x-service-token",
  "x-timestamp",
  "x-wallet-address",
  "x-wallet-signature",
] as const;
const CLOUD_ONLY_CREDENTIAL_HEADER_PREFIXES = [
  "cf-access-",
  "x-steward-",
] as const;

// Tests override every route's headers budget so the timeout paths complete in
// milliseconds without weakening production's path-specific limits.
let originHeadersTimeoutOverrideMs: number | null = null;

/**
 * Synchronous workflow generation and execution do not produce headers until
 * their result exists, so their proxy budget must match the engine operation.
 * The client keeps a ten-percent response-envelope buffer beyond these limits;
 * ordinary agent routes retain the short dead-origin guard.
 */
export function dedicatedProxyOriginHeadersTimeoutMs(
  method: string,
  pathname: string,
): number {
  if (method.toUpperCase() !== "POST") {
    return DEFAULT_ORIGIN_HEADERS_TIMEOUT_MS;
  }

  const normalizedPath = pathname.replace(/\/+$/, "");
  if (
    normalizedPath === "/api/workflow/workflows/generate" ||
    normalizedPath === "/api/workflow/workflows/resolve-clarification"
  ) {
    return WORKFLOW_GENERATION_HEADERS_TIMEOUT_MS;
  }
  if (/^\/api\/workflow\/workflows\/[^/]+\/run$/.test(normalizedPath)) {
    return WORKFLOW_RUN_HEADERS_TIMEOUT_MS;
  }
  return DEFAULT_ORIGIN_HEADERS_TIMEOUT_MS;
}

/**
 * Test-only seam for the headers-phase timeout. The `__` prefix + `TestHooks`
 * suffix mark it as non-public (same convention as the chat-completions route).
 */
export const __dedicatedProxyTestHooks = {
  setOriginHeadersTimeoutMs(ms: number): void {
    originHeadersTimeoutOverrideMs = ms;
  },
  resetOriginHeadersTimeoutMs(): void {
    originHeadersTimeoutOverrideMs = null;
  },
  get originHeadersTimeoutMs(): number {
    return originHeadersTimeoutOverrideMs ?? DEFAULT_ORIGIN_HEADERS_TIMEOUT_MS;
  },
} as const;

function resolveOriginHost(env: Bindings): string {
  const raw = env.AGENT_ROUTER_ORIGIN_HOST?.trim().toLowerCase();
  return raw && raw.length > 0 ? raw : DEFAULT_AGENT_ROUTER_ORIGIN_HOST;
}

function managedPairHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return headers;
}

function escapeManagedPairHtml(value: string): string {
  return value.replace(/[<>&]/g, (character) =>
    character === "<" ? "&lt;" : character === ">" ? "&gt;" : "&amp;",
  );
}

function managedPairDashboardUrl(url: URL): string {
  const environment =
    elizaCloudEnvironmentForHostname(url.hostname) ?? "production";
  return `${ELIZA_DOMAIN_CONTRACTS[environment].cloudAppOrigin}/cloud/agents`;
}

function renderManagedPairError(
  url: URL,
  title: string,
  message: string,
): string {
  const safeTitle = escapeManagedPairHtml(title);
  const safeMessage = escapeManagedPairHtml(message);
  const dashboardUrl = managedPairDashboardUrl(url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e5e5e5}
    .card{max-width:28rem;padding:2rem;border-radius:.75rem;background:rgba(255,255,255,.04);text-align:center}
    h1{font-size:1.1rem;margin:0 0 .75rem;font-weight:600}
    p{margin:0 0 1.25rem;opacity:.8;font-size:.9rem;line-height:1.5}
    a{color:#e5e5e5;text-decoration:none;font-size:.85rem;opacity:.7}
    a:hover{opacity:1}
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a href="${dashboardUrl}" rel="noopener">Back to Eliza Cloud</a>
  </div>
</body>
</html>`;
}

function managedPairErrorResponse(
  url: URL,
  status: number,
  title: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return new Response(renderManagedPairError(url, title, message), {
    status,
    headers: managedPairHeaders(extraHeaders),
  });
}

async function handleManagedPairAtEdge(
  request: Request,
  env: Bindings,
  url: URL,
  agentId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return managedPairErrorResponse(
      url,
      405,
      "Unsupported request",
      "Open the agent from Eliza Cloud to start a fresh sign-in.",
      { allow: "GET" },
    );
  }

  const rateLimiter = env.GLOBAL_RATE_LIMITER;
  if (!rateLimiter) {
    logger.error("[dedicated-proxy] managed pairing rate limiter unavailable", {
      agentId,
    });
    return managedPairErrorResponse(
      url,
      503,
      "Agent sign-in is unavailable",
      "Eliza Cloud could not validate this sign-in safely. Try again shortly.",
    );
  }

  try {
    const clientIp =
      request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const rateLimit = await rateLimiter.limit({
      key: `managed-pair:${clientIp}`,
    });
    if (!rateLimit.success) {
      return managedPairErrorResponse(
        url,
        429,
        "Too many sign-in attempts",
        "Wait a minute and open your agent again from Eliza Cloud.",
        { "retry-after": String(MANAGED_PAIR_RATE_LIMIT_RETRY_SECONDS) },
      );
    }
  } catch (error) {
    // error-policy:J1 the edge boundary fails closed when its platform rate
    // limiter is unavailable, rather than redeeming an unmetered bearer.
    logger.error("[dedicated-proxy] managed pairing rate limiter failed", {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return managedPairErrorResponse(
      url,
      503,
      "Agent sign-in is unavailable",
      "Eliza Cloud could not validate this sign-in safely. Try again shortly.",
    );
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token || !MANAGED_PAIR_TOKEN_PATTERN.test(token)) {
    return managedPairErrorResponse(
      url,
      400,
      "Invalid pairing link",
      "Open the agent from Eliza Cloud so a fresh sign-in link is generated.",
    );
  }

  try {
    const claim = await getPairingTokenService().claimBrowserToken(token, {
      agentId,
      expectedOrigin: url.origin,
    });
    if (claim.status === "invalid") {
      return managedPairErrorResponse(
        url,
        403,
        "Sign-in link expired",
        "Pairing links are single-use and valid for one minute. Open your agent again from Eliza Cloud.",
      );
    }
    if (claim.status === "sandbox-credential-unavailable") {
      return managedPairErrorResponse(
        url,
        503,
        "Agent sign-in is unavailable",
        "The agent is running without a usable sign-in credential. Try again shortly.",
      );
    }
    return new Response(renderCloudPairHandoffHtml(claim.apiKey, agentId), {
      status: 200,
      headers: managedPairHeaders(),
    });
  } catch (error) {
    // error-policy:J1 the public request boundary translates storage failures
    // into a visible error without forwarding the token to an untrusted hop.
    logger.error("[dedicated-proxy] managed pairing claim failed", {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return managedPairErrorResponse(
      url,
      500,
      "Agent sign-in failed",
      "Eliza Cloud could not complete this sign-in. Open the agent again from the dashboard.",
    );
  }
}

function stripCloudOnlyCredentials(headers: Headers): void {
  for (const name of CLOUD_ONLY_CREDENTIAL_HEADERS) {
    headers.delete(name);
  }
  for (const name of Array.from(headers.keys())) {
    if (
      CLOUD_ONLY_CREDENTIAL_HEADER_PREFIXES.some((prefix) =>
        name.startsWith(prefix),
      )
    ) {
      headers.delete(name);
    }
  }
}

/**
 * Forward the request to the agent-router origin (the CP), preserving
 * path / method / body. When `injectBearer` is provided, the inbound auth is
 * REPLACED with the agent's own `ELIZA_API_TOKEN` (so the container accepts it);
 * otherwise agent-local auth headers pass through and the container's own auth
 * applies. Browser cookies never cross the Cloud-to-container trust boundary.
 */
async function proxyToOrigin(
  request: Request,
  env: Bindings,
  url: URL,
  injectBearer?: string,
  injectQueryCredential?: RealtimeQueryCredentialName | null,
): Promise<Response> {
  const targetUrl = new URL(request.url);
  targetUrl.hostname = resolveOriginHost(env);
  const headers = new Headers(request.headers);
  headers.delete("host");
  stripCloudOnlyCredentials(headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  if (injectBearer) {
    headers.set("authorization", `Bearer ${injectBearer}`);
    headers.delete("x-api-key");
    // The realtime WebSocket carries the token as `?token=` (browsers can't set
    // headers on `new WebSocket()`); the container reads it via
    // ELIZA_ALLOW_WS_QUERY_TOKEN. Rewrite that query param to the agent token
    // too so the upgrade authenticates the same way the header does.
    for (const name of REALTIME_QUERY_CREDENTIAL_NAMES) {
      targetUrl.searchParams.delete(name);
    }
    if (injectQueryCredential) {
      targetUrl.searchParams.set(injectQueryCredential, injectBearer);
    }
  }
  // The timeout guards the HEADERS phase only. A blanket
  // `AbortSignal.timeout(30s)` on the fetch aborted the WHOLE transfer, so any
  // agent turn or SSE/WebSocket stream still flowing at t=30s was killed
  // mid-body and the unhandled TimeoutError surfaced to the client as a
  // CF 1101 / empty body — while the agent's reply persisted server-side. The
  // timer is cleared the moment the Response object (headers) arrives, so an
  // established stream flows for as long as the origin keeps it open; only an
  // origin that never answers is aborted, and that is translated into a
  // structured 504 the client can read instead of a thrown TimeoutError.
  const timeoutMs =
    originHeadersTimeoutOverrideMs ??
    dedicatedProxyOriginHeadersTimeoutMs(request.method, targetUrl.pathname);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("origin response headers timed out", "TimeoutError"),
    );
  }, timeoutMs);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal: controller.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    return await fetch(new Request(targetUrl, init));
  } catch (error) {
    // error-policy:J1 boundary translation — the headers-phase timeout becomes
    // a structured, retryable 504 instead of an unhandled TimeoutError (CF 1101).
    if (!timedOut) throw error;
    logger.warn("[dedicated-proxy] origin did not respond within timeout", {
      host: targetUrl.hostname,
      path: targetUrl.pathname,
      timeoutMs,
    });
    const response = Response.json(
      {
        success: false,
        code: "agent_timeout",
        error:
          "Agent did not start responding in time. The agent may still be processing; retry shortly.",
      },
      { status: 504 },
    );
    response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
    return response;
  } finally {
    clearTimeout(timer);
  }
}

type Sandbox = NonNullable<
  Awaited<ReturnType<typeof agentSandboxesRepository.findByIdAndOrg>>
>;

/**
 * A non-`running` dedicated agent can't be reached. Kick off (or detect an
 * in-flight) resume and tell the client to retry — the same self-healing flow
 * the pairing endpoint exposes, so the app drives one resume+poll loop for both.
 */
async function resumeAndRespond(
  sandbox: Sandbox,
  agentId: string,
  orgId: string,
  userId: string,
): Promise<Response> {
  if (sandbox.status === "error") {
    return Response.json(
      {
        success: false,
        code: "agent_error_state",
        error:
          "Agent is in an error state. Resolve the failure before connecting.",
        data: { status: sandbox.status },
      },
      { status: 503 },
    );
  }

  let jobId: string | undefined;
  let alreadyInProgress = false;
  if (RESUMABLE_STATUSES.has(sandbox.status)) {
    // A suspended / zero-balance org must NOT get free compute by hitting its
    // own agent subdomain. Gate the auto-resume on credits, mirroring the
    // pairing-token endpoint (#11224/#11227). Without this, billing suspension
    // (active-billing sets status='stopped') is defeated: every proxied request
    // would re-provision the container for free — the daemon executor does no
    // credit re-check, so this HTTP call-site is the only gate. (#11583)
    const creditCheck = await checkAgentCreditGate(orgId);
    if (!creditCheck.allowed) {
      logger.warn(
        "[dedicated-proxy] auto-resume blocked: insufficient credits",
        {
          agentId,
          orgId,
          balance: creditCheck.balance,
          required: AGENT_PRICING.MINIMUM_DEPOSIT,
        },
      );
      return Response.json(
        {
          success: false,
          code: "insufficient_credits",
          error:
            creditCheck.error ?? "Insufficient credits to resume this agent",
          requiredBalance: AGENT_PRICING.MINIMUM_DEPOSIT,
          currentBalance: creditCheck.balance,
        },
        { status: 402 },
      );
    }
    const workerHealth = await checkProvisioningWorkerHealth();
    if (workerHealth.ok) {
      try {
        const { job, created } =
          await provisioningJobService.enqueueAgentProvisionOnce({
            agentId,
            organizationId: orgId,
            userId,
            agentName: sandbox.agent_name ?? agentId,
            expectedLifecycleRevision: sandbox.lifecycle_revision,
          });
        jobId = job.id;
        alreadyInProgress = !created;
      } catch (error) {
        logger.warn("[dedicated-proxy] auto-resume enqueue failed", {
          agentId,
          orgId,
          status: sandbox.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.warn("[dedicated-proxy] auto-resume blocked: worker unavailable", {
        agentId,
        orgId,
        status: sandbox.status,
        code: workerHealth.code,
      });
    }
  }

  const response = Response.json(
    {
      success: true,
      data: {
        agentId,
        status: "starting",
        jobId,
        alreadyInProgress,
        retryAfterMs: RETRY_AFTER_SECONDS * 1000,
        message:
          "Agent is starting. Resume has been requested; retry after the suggested interval.",
      },
    },
    { status: 202 },
  );
  response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return response;
}

/**
 * The cloud token arrives in the Authorization header (or `x-api-key`) for HTTP
 * requests, but the realtime WebSocket can't set headers on `new WebSocket()` —
 * so the app passes it as a `?token=` query param (gated on the container by
 * ELIZA_ALLOW_WS_QUERY_TOKEN). Detect a query-only token so we validate it the
 * same way and inject the swapped agent token back on the same channel.
 */
const REALTIME_QUERY_CREDENTIAL_NAMES = ["token", "apiKey", "api_key"] as const;
type RealtimeQueryCredentialName =
  (typeof REALTIME_QUERY_CREDENTIAL_NAMES)[number];

interface RealtimeQueryCredentials {
  effective: { name: RealtimeQueryCredentialName; value: string } | null;
  values: string[];
}

function readRealtimeQueryCredentials(url: URL): RealtimeQueryCredentials {
  const values: string[] = [];
  let effective: RealtimeQueryCredentials["effective"] = null;
  for (const name of REALTIME_QUERY_CREDENTIAL_NAMES) {
    for (const raw of url.searchParams.getAll(name)) {
      const value = raw.trim();
      if (!value) continue;
      values.push(value);
      if (!effective) effective = { name, value };
    }
  }
  return { effective, values };
}

function isCloudCredentialShape(value: string | null): boolean {
  if (!value) return false;
  if (value.startsWith("eliza_")) return true;
  const jwtParts = value.split(".");
  return jwtParts.length === 3 && jwtParts.every((part) => part.length > 0);
}

function hasCloudCredentialShape(
  request: Request,
  queryCredentials: readonly string[],
): boolean {
  const apiKey = request.headers.get("x-api-key")?.trim() ?? null;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  return (
    isCloudCredentialShape(apiKey) ||
    isCloudCredentialShape(bearerMatch?.[1]?.trim() ?? null) ||
    queryCredentials.some((value) => isCloudCredentialShape(value))
  );
}

/**
 * Browser origins allowed to call a dedicated agent through the Worker.
 * Tenant-owned agent subdomains are deliberately excluded from the shared
 * first-party set: they must never borrow a visitor's Cloud session to call a
 * different tenant's agent.
 */
function isDedicatedProxyBrowserOriginAllowed(
  request: Request,
  url: URL,
): boolean {
  const origin = request.headers.get("origin")?.trim();
  if (!origin) return true;
  return origin === url.origin || isFirstPartyOrigin(origin);
}

/**
 * The Worker, rather than a tenant-controlled agent or the router, owns the
 * browser policy for every dedicated-host response. Agent-local auth is bearer
 * based, so parent-domain cookies never need credentialed CORS here.
 */
function applyDedicatedProxyCors(
  request: Request,
  url: URL,
  headers: Headers,
): boolean {
  for (const name of Array.from(headers.keys())) {
    if (name.startsWith("access-control-")) headers.delete(name);
  }

  const origin = request.headers.get("origin")?.trim();
  if (origin && !isDedicatedProxyBrowserOriginAllowed(request, url)) {
    return false;
  }

  headers.set("access-control-allow-origin", origin ?? "*");
  const vary = new Map<string, string>();
  for (const value of (headers.get("vary") ?? "").split(",")) {
    const trimmed = value.trim();
    if (trimmed) vary.set(trimmed.toLowerCase(), trimmed);
  }
  vary.set("origin", "Origin");
  headers.set("vary", [...vary.values()].join(", "));
  headers.set(
    "access-control-allow-methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  headers.set(
    "access-control-allow-headers",
    "authorization,content-type,x-api-key",
  );
  return true;
}

function dedicatedProxyPreflight(request: Request, url: URL): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (!applyDedicatedProxyCors(request, url, headers)) {
    return new Response(null, { status: 403, headers });
  }
  return new Response(null, { status: 204, headers });
}

function withDedicatedProxyBrowserPolicy(
  request: Request,
  url: URL,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  headers.delete("clear-site-data");
  applyDedicatedProxyCors(request, url, headers);

  const webSocket = (response as Response & { webSocket?: WebSocket | null })
    .webSocket;
  if (response.status === 101) {
    if (!webSocket) {
      return new Response(null, {
        status: 502,
        headers,
      });
    }
    const upgradeResponseInit: ResponseInit & { webSocket: WebSocket } = {
      status: 101,
      statusText: response.statusText,
      headers,
      webSocket,
    };
    const upgradeResponse = new Response(null, upgradeResponseInit);
    // Bun's Fetch implementation accepts status 101 but ignores the Workers
    // `webSocket` ResponseInit extension. Preserve the endpoint in local tests
    // and non-workerd development without changing workerd's native response.
    if (!("webSocket" in upgradeResponse)) {
      Object.defineProperty(upgradeResponse, "webSocket", {
        configurable: false,
        enumerable: false,
        value: webSocket,
        writable: false,
      });
    }
    return upgradeResponse;
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isBridgeHostFallbackEnabled(env: Bindings): boolean {
  return (
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "true" ||
    env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK === "1"
  );
}

/**
 * Auth-unify + proxy a request bound for `https://<agentId>.cloud.eliza.app/*`.
 * The Worker owns the browser policy and preflight so neither the tenant agent
 * nor the router can widen credentialed access or make failures CORS-opaque.
 */
export function handleDedicatedAgentProxy(
  request: Request,
  env: Bindings,
  url: URL,
  agentId: string,
): Promise<Response> {
  if (url.pathname.replace(/\/+$/, "") === "/pair") {
    return runWithCloudBindingsAsync(env, () =>
      handleManagedPairAtEdge(request, env, url, agentId),
    );
  }
  // The whole browser-policy path runs inside the bindings context so
  // isFirstPartyOrigin reads THIS request's ENVIRONMENT binding — outside it
  // would fall back to process.env and silently evaluate as non-production.
  return runWithCloudBindingsAsync(env, async () => {
    if (!isDedicatedProxyBrowserOriginAllowed(request, url)) {
      return new Response(null, {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method === "OPTIONS") {
      return dedicatedProxyPreflight(request, url);
    }
    const response = await proxyDedicatedAgent(request, env, url, agentId);
    return withDedicatedProxyBrowserPolicy(request, url, response);
  });
}

async function proxyDedicatedAgent(
  request: Request,
  env: Bindings,
  url: URL,
  agentId: string,
): Promise<Response> {
  const queryCredentials = readRealtimeQueryCredentials(url);
  const headerCarriesCredential = Boolean(
    request.headers.get("authorization") || request.headers.get("x-api-key"),
  );
  const effectiveQueryCredential = headerCarriesCredential
    ? null
    : queryCredentials.effective;
  const authHeaders = new Headers(request.headers);
  authHeaders.delete("cookie");
  if (effectiveQueryCredential) {
    authHeaders.set(
      "authorization",
      `Bearer ${effectiveQueryCredential.value}`,
    );
  }
  const authRequest = new Request(request.url, {
    method: request.method,
    headers: authHeaders,
  });

  let orgId: string;
  let userId: string;
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(authRequest);
    orgId = user.organization_id;
    userId = user.id;
  } catch (error) {
    // error-policy:J1 only agent-local credential shapes pass through an
    // expected Cloud-auth rejection. Cloud API keys and Steward JWTs have stable
    // wire formats; retaining them after a failed user/JIT lookup could leak a
    // still-live credential to the container. Managed agent credentials use the
    // distinct `agent_` namespace; Cloud-shaped custom tokens are deliberately
    // reserved so this boundary remains unambiguous.
    if (error instanceof AuthenticationError) {
      if (hasCloudCredentialShape(request, queryCredentials.values)) {
        return Response.json(
          {
            success: false,
            code: "cloud_auth_rejected",
            error: "Cloud authentication failed",
          },
          { status: 401 },
        );
      }
      return proxyToOrigin(request, env, url);
    }

    if (error instanceof ForbiddenError) {
      return Response.json(
        {
          success: false,
          code: "agent_access_denied",
          error: "Agent access denied",
        },
        { status: 403 },
      );
    }

    logger.error("[dedicated-proxy] cloud credential validation failed", {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        code: "cloud_auth_unavailable",
        error: "Cloud authentication is temporarily unavailable",
      },
      { status: 503 },
    );
  }

  let agentToken: string;
  try {
    // 2. Ownership — the caller's org MUST own this dedicated agent. Not
    //    owned / not found / shared fails here. Forwarding a known-valid Cloud
    //    credential would hand it to a different tenant's container.
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      orgId,
    );
    if (!sandbox || sandbox.execution_tier === "shared") {
      return Response.json(
        {
          success: false,
          code: "agent_access_denied",
          error: "Agent access denied",
        },
        { status: 403 },
      );
    }

    // 3. Lifecycle — a non-running agent isn't reachable; resume + 202.
    if (sandbox.status !== "running") {
      return resumeAndRespond(sandbox, agentId, orgId, userId);
    }

    // 3b. Reachability — a `running` row can still lack a routable mesh
    //     ingress (empty headscale_ip, bridge-host fallback off — the staging
    //     default) because the container never finished joining headscale.
    //     Proxying it hits the CP, which returns a CORS-less 404 the browser
    //     reads as an opaque CORS failure, dead-ending chat (#15347). Mirror
    //     the router's own gate and short-circuit to a readable, CORS-bearing
    //     503 so the app renders a real "starting/unavailable" state and
    //     retries — no doomed CP round-trip.
    const headscaleIp = (sandbox.headscale_ip ?? "").trim();
    if (!headscaleIp && !isBridgeHostFallbackEnabled(env)) {
      logger.warn(
        "[dedicated-proxy] agent running but unroutable (no headscale_ip)",
        { agentId, orgId, status: sandbox.status },
      );
      const response = Response.json(
        {
          success: false,
          code: "agent_unroutable",
          error:
            "Agent is running but has no routable network ingress yet (mesh join incomplete). Retry shortly.",
        },
        { status: 503 },
      );
      response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
      return response;
    }

    // 4. Unified auth — swap the validated owner's cloud token for the agent's
    //    own ELIZA_API_TOKEN so the container accepts the request. For a WS
    //    upgrade the token rode in `?token=`, so rewrite that too.
    const envVars = (sandbox.environment_vars ?? {}) as Record<string, string>;
    const resolvedAgentToken = envVars.ELIZA_API_TOKEN?.trim();
    if (!resolvedAgentToken) {
      logger.error("[dedicated-proxy] agent credential unavailable", {
        agentId,
        orgId,
      });
      return Response.json(
        {
          success: false,
          code: "agent_credential_unavailable",
          error: "Agent authentication is temporarily unavailable",
        },
        { status: 503 },
      );
    }
    agentToken = resolvedAgentToken;
  } catch (error) {
    // error-policy:J1 a validated Cloud credential never crosses into the
    // container when ownership or credential resolution fails.
    logger.error("[dedicated-proxy] owner credential resolution failed", {
      agentId,
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        success: false,
        code: "agent_auth_unavailable",
        error: "Agent authentication is temporarily unavailable",
      },
      { status: 503 },
    );
  }

  // Keep the origin fetch outside the resolution boundary so transport errors
  // preserve proxy semantics instead of being mistaken for auth failures.
  return proxyToOrigin(
    request,
    env,
    url,
    agentToken,
    effectiveQueryCredential?.name ?? null,
  );
}
