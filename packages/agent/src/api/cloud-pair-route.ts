/**
 * Loopback-only `/pair` relay for standalone agent servers.
 * Remote managed pairing terminates at the Cloud edge; explicit local Docker
 * retains this handler so the one-time token resolves before the SPA fallback.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  type CloudPairRelaySession,
  parseCloudPairRelaySession,
  renderCloudPairHandoffHtml,
  resolveCloudPairAgentIdFromEnv,
} from "@elizaos/shared/contracts";

const RELAY_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

export function __resetCloudPairRateLimitForTests(): void {
  rateBuckets.clear();
}

function rateLimitConsume(key: string | null): boolean {
  const now = Date.now();
  const bucketKey = key || "unknown";
  const current = rateBuckets.get(bucketKey);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(bucketKey, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function resolveCloudApiBaseUrl(): string {
  const raw =
    process.env.ELIZAOS_CLOUD_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "https://api.eliza.app/api/v1";
  return raw.replace(/\/+$/, "");
}

function resolveCloudAuthRoot(): string {
  return resolveCloudApiBaseUrl().replace(/\/api\/v1\/?$/, "");
}

/**
 * Externally served origin of a request: proxy metadata (X-Forwarded-Proto /
 * X-Forwarded-Host) first, then the TLS state and Host header. Empty string
 * when the request carries no host at all.
 */
export function resolveRequestOrigin(req: http.IncomingMessage): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ||
    (req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    // error-policy:J3 malformed request origins are never trusted as loopback.
    return false;
  }
}

function canUseManagedDirectRelay(req: http.IncomingMessage): boolean {
  return (
    process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY === "1" &&
    isLoopbackOrigin(resolveRequestOrigin(req))
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : "&quot;",
  );
}

/**
 * Canonical staging hostnames — mirrors `STAGING_CONSOLE_HOSTS` in
 * `packages/ui/src/utils/cloud-agent-base.ts` plus the wildcard subdomain.
 * Kept local (not imported) to preserve the agent→UI dependency boundary.
 * Update both if the canonical staging host set changes.
 */
const STAGING_CLOUD_HOSTS: ReadonlySet<string> = new Set([
  "staging.eliza.app",
  "api-staging.eliza.app",
  "cloud-staging.eliza.app",
  "staging.elizacloud.ai",
  "api-staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

function isStagingCloudHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    STAGING_CLOUD_HOSTS.has(host) ||
    host.endsWith(".cloud-staging.eliza.app") ||
    host.endsWith(".staging.elizacloud.ai")
  );
}

/**
 * Resolve the Eliza Cloud console dashboard URL for the environment the agent
 * is provisioned against. A staging agent (any canonical staging alias or
 * wildcard subdomain) gets the staging console; everything else gets the
 * production console. This prevents staging users from being bounced to a
 * production dashboard where their account/org/agent does not exist.
 */
function resolveCloudConsoleUrl(): string {
  try {
    const hostname = new URL(resolveCloudAuthRoot()).hostname.toLowerCase();
    if (isStagingCloudHostname(hostname)) {
      return "https://cloud-staging.eliza.app/cloud/agents";
    }
  } catch {
    // error-policy:J3 malformed auth root yields the production default.
  }
  return "https://cloud.eliza.app/cloud/agents";
}

function renderErrorHtml(
  title: string,
  message: string,
  recoveryUrl?: string,
): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeHref = escapeHtml(recoveryUrl ?? resolveCloudConsoleUrl());
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
    <a href="${safeHref}" target="_top" rel="noopener">Back to Eliza Cloud</a>
  </div>
</body>
</html>`;
}

function sendHtml(
  res: http.ServerResponse,
  status: number,
  body: string,
): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    pragma: "no-cache",
    expires: "0",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export async function handleStandaloneCloudPairRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "GET" || url.pathname !== "/pair") return false;

  if (!canUseManagedDirectRelay(req)) {
    sendHtml(
      res,
      421,
      renderErrorHtml(
        "Open this agent from Eliza Cloud",
        "Managed sign-in is completed at the agent's Eliza Cloud address. Return to the dashboard and open the agent again.",
      ),
    );
    return true;
  }

  const ip = req.socket.remoteAddress ?? null;
  if (!rateLimitConsume(ip)) {
    sendHtml(
      res,
      429,
      renderErrorHtml(
        "Too many sign-in attempts",
        "Wait a minute and try opening your agent again.",
      ),
    );
    return true;
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    sendHtml(
      res,
      400,
      renderErrorHtml(
        "Missing pairing token",
        "Open the agent from Eliza Cloud so a fresh sign-in link is generated.",
      ),
    );
    return true;
  }

  const origin = resolveRequestOrigin(req);
  if (!origin) {
    sendHtml(
      res,
      400,
      renderErrorHtml(
        "Missing origin",
        "Your browser did not send a Host header. Try again from a standard browser.",
      ),
    );
    return true;
  }

  const agentId = resolveCloudPairAgentIdFromEnv(process.env);
  if (!agentId) {
    sendHtml(
      res,
      503,
      renderErrorHtml(
        "Agent identity unavailable",
        "This local agent is missing its platform identity. Restart it from Eliza Cloud and try again.",
      ),
    );
    return true;
  }

  const exchangeUrl = `${resolveCloudAuthRoot()}/api/auth/pair`;
  let exchanged: CloudPairRelaySession | null = null;
  let status = 0;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    const response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token, agentId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = response.status;
    if (response.ok) {
      // error-policy:J3 a successful dependency response is still untrusted;
      // malformed JSON or missing bearer ownership becomes an explicit 502.
      const body: unknown = await response.json().catch(() => null);
      exchanged = parseCloudPairRelaySession(body);
    } else if (status !== 401 && status !== 403 && status !== 410) {
      // 401/403/410 are logged separately as pairing-link rejections below;
      // only unexpected non-2xx statuses get the generic warning here.
      logger.warn(
        `[cloud-pair] exchange returned non-2xx status=${status} exchangeUrl=${exchangeUrl} requestOrigin=${origin}`,
      );
    }
  } catch (err) {
    logger.error(
      `[cloud-pair] exchange failed url=${exchangeUrl} error=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    sendHtml(
      res,
      503,
      renderErrorHtml(
        "Eliza Cloud is unreachable",
        "We could not reach Eliza Cloud to verify your sign-in link. Try again in a minute.",
      ),
    );
    return true;
  }

  if (status === 401 || status === 403 || status === 410) {
    // Cloud returns one opaque body for ALL rejection causes: expired,
    // already-redeemed, unknown-to-this-environment, origin-not-bound, and
    // malformed. The relay cannot determine which cause applies, so the
    // rendered copy must NOT assert a specific cause — only that the link
    // could not be verified. See issue #18184.
    logger.warn(
      `[cloud-pair] pairing link rejected status=${status} exchangeUrl=${exchangeUrl} requestOrigin=${origin}`,
    );
    sendHtml(
      res,
      403,
      renderErrorHtml(
        "Sign-in link could not be verified",
        "Eliza Cloud could not verify this pairing link. It may have already been used, or does not match this agent. Open your agent again from Eliza Cloud to get a fresh link.",
      ),
    );
    return true;
  }

  if (status === 429) {
    sendHtml(
      res,
      429,
      renderErrorHtml(
        "Too many sign-in attempts",
        "Wait a minute and try opening your agent again.",
      ),
    );
    return true;
  }

  if (!exchanged) {
    sendHtml(
      res,
      502,
      renderErrorHtml(
        "Sign-in failed",
        "Eliza Cloud accepted the link but did not return a valid agent session. Try again from the dashboard.",
      ),
    );
    return true;
  }

  logger.info(
    `[cloud-pair] exchange ok agent=${exchanged.agentName ?? "agent"}`,
  );
  sendHtml(
    res,
    200,
    renderCloudPairHandoffHtml(exchanged.apiKey, exchanged.agentId),
  );
  return true;
}
