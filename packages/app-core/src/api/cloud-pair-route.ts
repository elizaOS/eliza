/**
 * Loopback-only `/pair` relay for the app host.
 *
 * Remote managed pairing terminates at the trusted Cloud edge. The explicit
 * local-Docker mode exchanges its one-time token server-side, validates the
 * returned owner, installs the scoped browser handoff, and fails visibly when
 * storage or the Cloud dependency is unavailable.
 *
 * Peer admission when `ELIZA_CLOUD_PAIR_DIRECT_RELAY=1` keys on the TCP peer,
 * never on request headers: loopback peers only, plus any ranges in the
 * optional `ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS` comma-separated CIDR
 * allowlist (default empty). The supported local-Docker deployment publishes
 * the port on the host's loopback, so inside the container the TCP peer is
 * the bridge gateway rather than 127.0.0.1 — set e.g.
 * `ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS=172.17.0.0/16` to admit exactly that
 * gateway range. Every CIDR entry widens token redemption to that LAN/VPC
 * segment, so keep the list as narrow as the deployment allows.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import {
  isLoopbackRemoteAddress,
  isRemoteAddressInCidrList,
} from "@elizaos/shared";
import {
  type CloudPairRelaySession,
  parseCloudPairRelaySession,
  renderCloudPairHandoffHtml,
  resolveCloudPairAgentIdFromEnv,
} from "@elizaos/shared/contracts";
import {
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared/elizacloud/domain-contract";
import { getSensitiveLimiter } from "./auth/sensitive-rate-limit";

const RELAY_TIMEOUT_MS = 15_000;
const pairingRelayLimiter = getSensitiveLimiter("cloud.pair.relay");

function resolveCloudApiBaseUrl(): string {
  const raw =
    process.env.ELIZAOS_CLOUD_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "https://api.eliza.app/api/v1";
  return raw.replace(/\/+$/, "");
}

function resolveCloudAuthRoot(): string {
  // Cloud-api mounts `/api/auth/pair` at the site root, not under `/api/v1`.
  // ELIZAOS_CLOUD_BASE_URL is the `/api/v1` URL, so strip the suffix to land
  // on the site root.
  const base = resolveCloudApiBaseUrl();
  return base.replace(/\/api\/v1\/?$/, "");
}

function resolveDirectRequestOrigin(req: http.IncomingMessage): string {
  // The origin forwarded to the Cloud exchange is built from direct request
  // metadata only — X-Forwarded-Host/X-Forwarded-Proto are client-controlled
  // and must not rewrite the origin the exchange is bound to (W5-014).
  const proto =
    req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http";
  const host = req.headers.host?.split(",", 1)[0]?.trim();
  return host ? `${proto}://${host}` : "";
}

function canUseManagedDirectRelay(req: http.IncomingMessage): boolean {
  if (process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY !== "1") return false;
  // The local-only gate must key on the TCP peer, never on request headers:
  // Host and X-Forwarded-Host are client-controlled, so a remote caller
  // could previously spoof a loopback origin and redeem a held pairing token
  // through this relay (W5-014). Non-loopback peers are admitted only through
  // the explicit ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS allowlist (W5-016) —
  // see the file header for the local-Docker gateway flow.
  const peer = req.socket?.remoteAddress;
  return (
    isLoopbackRemoteAddress(peer) ||
    isRemoteAddressInCidrList(
      peer,
      process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS,
    )
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"]/g, (character) => {
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === "&") return "&amp;";
    return "&quot;";
  });
}

function resolveCloudConsoleUrl(): string {
  try {
    const classified = classifyElizaHostname(
      new URL(resolveCloudAuthRoot()).hostname,
    );
    if (classified.environment) {
      return `${ELIZA_DOMAIN_CONTRACTS[classified.environment].cloudAppOrigin}/cloud/agents`;
    }
  } catch {
    // error-policy:J3 malformed operator configuration uses the production
    // recovery destination instead of rendering an untrusted href.
  }
  return `${ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin}/cloud/agents`;
}

function renderErrorHtml(title: string, message: string): string {
  // Static error page — no token or inline user data, only a canonical
  // environment-aware recovery link so staging failures never cross to prod.
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeRecoveryUrl = escapeHtml(resolveCloudConsoleUrl());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
    }
    .card {
      max-width: 28rem;
      padding: 2rem;
      border-radius: 0.75rem;
      background: rgba(255, 255, 255, 0.04);
      text-align: center;
    }
    h1 { font-size: 1.1rem; margin: 0 0 0.75rem; font-weight: 600 }
    p { margin: 0 0 1.25rem; opacity: 0.8; font-size: 0.9rem; line-height: 1.5 }
    a {
      color: #e5e5e5;
      text-decoration: none;
      font-size: 0.85rem;
      opacity: 0.7;
    }
    a:hover { opacity: 1 }
  </style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a href="${safeRecoveryUrl}" target="_top" rel="noopener">Back to Eliza Cloud →</a>
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

export async function handleCloudPairRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "GET" || url.pathname !== "/pair") {
    return false;
  }

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
  if (!pairingRelayLimiter.consume(ip)) {
    sendHtml(
      res,
      429,
      renderErrorHtml(
        "Too many sign-in attempts",
        "Wait a minute and click 'Open Web UI' again from the dashboard.",
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
        "Open the agent from the Eliza Cloud dashboard so a fresh sign-in link is generated.",
      ),
    );
    return true;
  }

  const origin = resolveDirectRequestOrigin(req);
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
    const resp = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token, agentId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = resp.status;
    if (resp.ok) {
      // error-policy:J3 a 2xx with a non-JSON body → null, surfaced as a failed
      // exchange by the null-check that follows.
      const body: unknown = await resp.json().catch(() => null);
      exchanged = parseCloudPairRelaySession(body);
    } else {
      logger.warn(
        `[cloud-pair] exchange returned non-2xx status=${status} url=${exchangeUrl}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[cloud-pair] exchange failed url=${exchangeUrl} error=${message}`,
    );
    sendHtml(
      res,
      503,
      renderErrorHtml(
        "Eliza Cloud is unreachable",
        "We couldn't reach Eliza Cloud to verify your sign-in link. Try again in a minute.",
      ),
    );
    return true;
  }

  if (status === 401 || status === 403 || status === 410) {
    sendHtml(
      res,
      403,
      renderErrorHtml(
        "Sign-in link expired",
        "Pairing links are single-use and only valid for a minute. Click 'Open Web UI' again from the dashboard.",
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
        "Wait a minute and click 'Open Web UI' again from the dashboard.",
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
