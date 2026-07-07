/**
 * GET /pair - cloud pairing-token relay for hosted standalone agents.
 *
 * Some cloud agents boot the agent server without the app-core host bridge.
 * They still must own /pair before the static SPA fallback, otherwise the
 * browser lands on /pair?token=... as a normal app route and the one-time
 * token is never exchanged for the agent-local API key.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";

const RELAY_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

interface PairResponse {
  apiKey?: string | null;
  agentName?: string;
  error?: string;
}

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
    "https://api.elizacloud.ai/api/v1";
  return raw.replace(/\/+$/, "");
}

function resolveCloudAuthRoot(): string {
  return resolveCloudApiBaseUrl().replace(/\/api\/v1\/?$/, "");
}

function resolveRequestOrigin(req: http.IncomingMessage): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ||
    (req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
}

function renderRedirectHtml(apiKey: string): string {
  const safeKey = JSON.stringify(apiKey).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>Signing in...</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e5e5e5}
    p{margin:0;font-size:.9rem;opacity:.8}
  </style>
</head>
<body>
  <p>Signing in to your agent...</p>
  <script>
    (function () {
      try {
        var key = ${safeKey};
        window.sessionStorage.setItem("eliza:cloud-pair:api-token", key);
        var slot = Symbol.for("elizaos.app.boot-config");
        var previous = window.__ELIZAOS_APP_BOOT_CONFIG__ ||
          window.__ELIZA_APP_BOOT_CONFIG__ ||
          (window[slot] && window[slot].current) ||
          {};
        var next = Object.assign({}, previous, { apiToken: key });
        window.__ELIZAOS_APP_BOOT_CONFIG__ = next;
        window.__ELIZA_APP_BOOT_CONFIG__ = next;
        window[slot] = { current: next };
      } catch (e) {
        console.error("[cloud-pair] failed to persist the paired token", e);
        var p = document.querySelector("p");
        if (p) p.textContent = "Pairing failed. Close this window and try signing in again.";
        return;
      }
      window.location.replace("/");
    })();
  </script>
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
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
    <a href="https://www.elizacloud.ai/dashboard/agents" target="_top" rel="noopener">Back to Eliza Cloud</a>
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

  const exchangeUrl = `${resolveCloudAuthRoot()}/api/auth/pair`;
  let exchanged: PairResponse | null = null;
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
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = response.status;
    if (response.ok) {
      exchanged = (await response.json().catch(() => null)) as
        | PairResponse
        | null;
    } else {
      logger.warn(
        `[cloud-pair] exchange returned non-2xx status=${status} url=${exchangeUrl}`,
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
    sendHtml(
      res,
      403,
      renderErrorHtml(
        "Sign-in link expired",
        "Pairing links are single-use and only valid for a minute. Open your agent again from Eliza Cloud.",
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

  if (!exchanged || typeof exchanged.apiKey !== "string" || !exchanged.apiKey) {
    sendHtml(
      res,
      502,
      renderErrorHtml(
        "Sign-in failed",
        "Eliza Cloud accepted the link but did not return a key. Try again from the dashboard.",
      ),
    );
    return true;
  }

  logger.info(
    `[cloud-pair] exchange ok agent=${exchanged.agentName ?? "agent"}`,
  );
  sendHtml(res, 200, renderRedirectHtml(exchanged.apiKey));
  return true;
}
