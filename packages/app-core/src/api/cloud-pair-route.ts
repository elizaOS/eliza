/**
 * GET /pair — server-side relay for the Eliza Cloud SSO popup.
 *
 * Flow:
 *   1. Cloud dashboard mints a 60s pairing token via
 *      POST /api/v1/eliza/agents/<id>/pairing-token and navigates a popup to
 *      `<agent>/pair?token=<X>`.
 *   2. This handler reads the token, calls cloud-api `POST /api/auth/pair`
 *      server-side (origin header = the agent's own origin, so cloud-api's
 *      origin gate matches what was baked into the token).
 *   3. Cloud-api validates + consumes the token, returns
 *      `{ apiKey: <ELIZA_API_TOKEN> }`.
 *   4. This handler serves an HTML page with an inline script that stores the
 *      apiKey in sessionStorage and the typed boot-config singleton, then
 *      redirects to `/`. The SPA consumes that same-tab session handoff on boot.
 *
 * Why server-side relay: the agent web UI runs on the docker node's public
 * IP, which is not in cloud-api's CORS allowlist. A direct browser fetch to
 * `api.elizacloud.ai` would fail preflight. Doing the exchange from the
 * agent's Node process sidesteps CORS entirely.
 */

import type http from "node:http";
import { logger } from "@elizaos/core";
import { getSensitiveLimiter } from "./auth/sensitive-rate-limit";

const RELAY_TIMEOUT_MS = 15_000;
const pairingRelayLimiter = getSensitiveLimiter("cloud.pair.relay");

function resolveCloudApiBaseUrl(): string {
  const raw =
    process.env.ELIZAOS_CLOUD_BASE_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "https://api.elizacloud.ai/api/v1";
  return raw.replace(/\/+$/, "");
}

function resolveCloudAuthRoot(): string {
  // Cloud-api mounts `/api/auth/pair` at the site root, not under `/api/v1`.
  // ELIZAOS_CLOUD_BASE_URL is the `/api/v1` URL, so strip the suffix to land
  // on the site root.
  const base = resolveCloudApiBaseUrl();
  return base.replace(/\/api\/v1\/?$/, "");
}

function resolveRequestOrigin(req: http.IncomingMessage): string {
  // Honor the proxy headers a control-plane front (Cloudflared, nginx) adds,
  // then fall back to the Host header. The cloud-api side uses this origin
  // verbatim to look up the pairing-token row (which was baked with the same
  // shape at generate time).
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ||
    (req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

interface PairResponse {
  apiKey?: string | null;
  agentName?: string;
  error?: string;
}

function renderRedirectHtml(apiKey: string): string {
  // JSON.stringify gives us a JS-string literal that safely escapes quotes,
  // but it does NOT escape `</script>` — which would break us out of the
  // inline script tag. Replace `<` with the `<` escape so any
  // `</script>` payload in a malicious key becomes inert literal text.
  const safeKey = JSON.stringify(apiKey).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <title>Signing in…</title>
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
    p { margin: 0; font-size: 0.9rem; opacity: 0.8 }
  </style>
</head>
<body>
  <p>Signing in to your agent…</p>
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
        // A failed handoff must NOT silently redirect to "/" unpaired — the
        // user would land signed-out with no clue why. Surface it: log to the
        // browser console and show a visible failure instead of redirecting.
        console.error("[cloud-pair] failed to persist the paired token", e);
        var p = document.querySelector("p");
        if (p) {
          p.textContent =
            "Pairing failed. Close this window and try signing in again.";
        }
        return;
      }
      window.location.replace("/");
    })();
  </script>
</body>
</html>`;
}

function renderErrorHtml(title: string, message: string): string {
  // Static error page — no token, no inline data, just a back link to the
  // dashboard so the user can re-trigger the popup.
  const safeTitle = title.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
  const safeMessage = message.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
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
    <a href="https://www.elizacloud.ai/dashboard/agents" target="_top" rel="noopener">Back to Eliza Cloud →</a>
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

export async function handleCloudPairRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method !== "GET" || url.pathname !== "/pair") {
    return false;
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
    const resp = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    status = resp.status;
    if (resp.ok) {
      exchanged = (await resp.json().catch(() => null)) as PairResponse | null;
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
