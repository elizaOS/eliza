/**
 * Authentication and proxy boundary for dedicated-agent subdomains.
 *
 * Managed browser pairing terminates here and atomically binds the one-time
 * token to the URL agent and origin. Ordinary requests swap a validated Cloud
 * owner's credential for the container credential; every unauthenticated,
 * non-owner, or failed-validation path reaches the container without an
 * injected secret, leaving its own auth as the backstop. The module stays lazy
 * so non-agent Worker requests do not pay its startup cost.
 */

import { renderCloudPairHandoffHtml } from "@elizaos/shared/contracts";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import { checkProvisioningWorkerHealth } from "@/lib/services/provisioning-worker-health";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

type Bindings = AppEnv["Bindings"];

const DEFAULT_AGENT_ROUTER_ORIGIN_HOST = "eliza-production-1.elizacloud.ai";

/** Non-`running` statuses we auto-resume on (mirrors the pairing endpoint). */
const RESUMABLE_STATUSES = new Set(["pending", "stopped", "disconnected"]);
const RETRY_AFTER_SECONDS = 5;
const DEFAULT_ORIGIN_HEADERS_TIMEOUT_MS = 30_000;
const WORKFLOW_GENERATION_HEADERS_TIMEOUT_MS = 5 * 60_000;
const WORKFLOW_RUN_HEADERS_TIMEOUT_MS = 10 * 60_000;
const MANAGED_PAIR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MANAGED_PAIR_RATE_LIMIT_RETRY_SECONDS = 60;

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
  return url.hostname.endsWith(".staging.elizacloud.ai")
    ? "https://staging.elizacloud.ai/dashboard/agents"
    : "https://elizacloud.ai/dashboard/agents";
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

/**
 * Forward the request to the agent-router origin (the CP), preserving
 * path / method / body. When `injectBearer` is provided, the inbound auth is
 * REPLACED with the agent's own `ELIZA_API_TOKEN` (so the container accepts it);
 * otherwise headers pass through unchanged and the container's own auth applies.
 */
async function proxyToOrigin(
  request: Request,
  env: Bindings,
  url: URL,
  injectBearer?: string,
  injectQueryToken = false,
): Promise<Response> {
  const targetUrl = new URL(request.url);
  targetUrl.hostname = resolveOriginHost(env);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  if (injectBearer) {
    headers.set("authorization", `Bearer ${injectBearer}`);
    headers.delete("x-api-key");
    // The realtime WebSocket carries the token as `?token=` (browsers can't set
    // headers on `new WebSocket()`); the container reads it via
    // ELIZA_ALLOW_WS_QUERY_TOKEN. Rewrite that query param to the agent token
    // too so the upgrade authenticates the same way the header does.
    if (injectQueryToken) {
      targetUrl.searchParams.set("token", injectBearer);
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
function extractQueryToken(request: Request, url: URL): string | null {
  // A header already carries auth → let the normal request validation handle it.
  if (
    request.headers.get("authorization") ||
    request.headers.get("x-api-key")
  ) {
    return null;
  }
  return url.searchParams.get("token")?.trim() || null;
}

/**
 * CORS headers for a browser-visible proxy response. The CP (nginx → agent-router)
 * forwards verbatim and injects nothing, so its CORS-less 404/503 — and our own
 * JSON error envelopes — reach the browser as an opaque
 * "No 'Access-Control-Allow-Origin'" failure (#15347). Reflect the caller's
 * Origin (mirrors the agent's own `resolveCorsOrigin`, which reflects any origin
 * when provisioned); `*` only for a header-less non-browser caller.
 */
function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    vary: "origin",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-api-key",
  };
}

/**
 * Guarantee CORS on a browser-visible response. Applied only when the response
 * lacks it, so the agent's own CORS-bearing responses (the happy path) pass
 * through untouched and only the CP's/our error responses are augmented.
 */
function withCors(request: Request, response: Response): Response {
  if (response.headers.has("access-control-allow-origin")) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeadersFor(request))) {
    headers.set(key, value);
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
 * Auth-unify + proxy a request bound for `https://<agentId>.elizacloud.ai/*`.
 * Every browser-visible return path carries CORS (`withCors`), and a CORS
 * preflight is answered at the edge so a cross-origin agent call is never blocked
 * by the CP's CORS-less responses (#15347).
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
  if (request.method === "OPTIONS") {
    return Promise.resolve(
      new Response(null, { status: 204, headers: corsHeadersFor(request) }),
    );
  }
  return runWithCloudBindingsAsync(env, async () => {
    const response = await proxyDedicatedAgent(request, env, url, agentId);
    return withCors(request, response);
  });
}

async function proxyDedicatedAgent(
  request: Request,
  env: Bindings,
  url: URL,
  agentId: string,
): Promise<Response> {
  try {
    // 1. Validate the CLOUD token. It rides in the Authorization header for
    //    HTTP, or as `?token=` for the WebSocket upgrade. No valid token →
    //    pass through unchanged (web UI assets and the agent's own token);
    //    the container's auth is the backstop. Managed pairing never reaches
    //    this function because it terminates at the edge above.
    const queryToken = extractQueryToken(request, url);
    // Header/cookie auth validates the ORIGINAL request (preserves every
    // existing auth method); a query-only (WS) token validates through a
    // synthetic header request so it takes the exact same path.
    const authRequest = queryToken
      ? new Request(request.url, {
          headers: { authorization: `Bearer ${queryToken}` },
        })
      : request;
    let orgId: string;
    let userId: string;
    try {
      const { user } = await requireAuthOrApiKeyWithOrg(authRequest);
      orgId = user.organization_id;
      userId = user.id;
    } catch {
      return proxyToOrigin(request, env, url);
    }

    // 2. Ownership — the caller's org MUST own this dedicated agent. Not
    //    owned / not found / shared → pass through unchanged (never widen
    //    access here; the container's own token auth rejects non-owners).
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      orgId,
    );
    if (!sandbox || sandbox.execution_tier === "shared") {
      return proxyToOrigin(request, env, url);
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
    const agentToken = envVars.ELIZA_API_TOKEN?.trim();
    // No managed token (older / not-yet-provisioned agent) → pass through.
    return proxyToOrigin(
      request,
      env,
      url,
      agentToken || undefined,
      queryToken !== null,
    );
  } catch (error) {
    // Fail-closed: any unexpected error → pass through WITHOUT injecting, so
    // the container's own auth still gates access.
    logger.error(
      "[dedicated-proxy] unexpected error; passing through unauthenticated",
      {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return proxyToOrigin(request, env, url);
  }
}
