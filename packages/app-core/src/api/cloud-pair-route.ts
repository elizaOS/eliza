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
 *
 * Popup-free JSON mode (#15132): when the request carries
 * `Accept: application/json` or `?format=json`, the identical server-side
 * exchange answers `{ apiKey, agentName }` as JSON (errors as
 * `{ error, code }` with the same status mapping) instead of the HTML
 * handoff page. This is the transport for the SPA's programmatic
 * credential repair (`@elizaos/ui` repair-agent-credential) after a
 * container upgrade rotates ELIZA_API_TOKEN. Trusted Eliza Cloud web
 * origins (and the app WebView origins) get their Origin echoed so the
 * apex-served SPA can call this agent-origin relay cross-origin; the
 * same one-time-token + origin gate at cloud-api authorizes the exchange.
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

/**
 * Eliza Cloud web hosts allowed to read the JSON pair exchange cross-origin.
 * Mirrors the control-plane host set in `@elizaos/ui` (persistence.ts /
 * cloud-agent-base.ts) plus the app SPA hosts. Authorization is NOT this
 * allowlist — the one-time pairing token is — but only first-party SPAs have a
 * reason to read the response, so nobody else gets a CORS grant.
 */
const TRUSTED_PAIR_JSON_ORIGIN_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "app.elizacloud.ai",
  "api.elizacloud.ai",
  "staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
]);

// Capacitor WebView / local-dev origins for the Eliza app — mirrors the
// dedicated-agent CORS allowlist in packages/agent/src/api (the app can point
// its client at a dedicated agent base and run the same repair).
const APP_LOCAL_PAIR_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const APP_SCHEME_PAIR_ORIGIN_RE =
  /^(capacitor|capacitor-electron):\/\/localhost$/i;

function corsHeadersForJsonPair(
  req: http.IncomingMessage,
): Record<string, string> {
  const origin = (req.headers.origin as string | undefined)?.trim();
  // Same-origin (or non-browser) callers send no Origin — no grant needed.
  if (!origin) return {};
  let trusted = false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    trusted =
      TRUSTED_PAIR_JSON_ORIGIN_HOSTS.has(hostname) ||
      APP_LOCAL_PAIR_ORIGIN_RE.test(origin) ||
      APP_SCHEME_PAIR_ORIGIN_RE.test(origin);
  } catch {
    // error-policy:J3 a malformed Origin header is untrusted input — fail
    // closed to "no CORS grant" (the response is still served same-origin).
    trusted = false;
  }
  if (!trusted) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

function sendJson(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    pragma: "no-cache",
    expires: "0",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...corsHeadersForJsonPair(req),
  });
  res.end(JSON.stringify(body));
}

/**
 * The popup navigation wants the HTML handoff page; the programmatic repair
 * wants JSON. `Accept: application/json` is the canonical switch; `?format=json`
 * is a belt-and-braces duplicate for intermediaries that rewrite Accept.
 */
function wantsJsonPairResponse(req: http.IncomingMessage, url: URL): boolean {
  if (url.searchParams.get("format") === "json") return true;
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("application/json");
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

  const json = wantsJsonPairResponse(req, url);
  // One dispatcher per error so the two response modes can never drift on
  // status codes — JSON carries a machine-readable `code`, HTML the page copy.
  const fail = (
    status: number,
    code: string,
    title: string,
    message: string,
  ): void => {
    if (json) {
      sendJson(req, res, status, { error: message, code });
      return;
    }
    sendHtml(res, status, renderErrorHtml(title, message));
  };

  const ip = req.socket.remoteAddress ?? null;
  if (!pairingRelayLimiter.consume(ip)) {
    fail(
      429,
      "rate_limited",
      "Too many sign-in attempts",
      "Wait a minute and click 'Open Web UI' again from the dashboard.",
    );
    return true;
  }

  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    fail(
      400,
      "missing_token",
      "Missing pairing token",
      "Open the agent from the Eliza Cloud dashboard so a fresh sign-in link is generated.",
    );
    return true;
  }

  const origin = resolveRequestOrigin(req);
  if (!origin) {
    fail(
      400,
      "missing_origin",
      "Missing origin",
      "Your browser did not send a Host header. Try again from a standard browser.",
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
      // error-policy:J3 a 2xx with a non-JSON body → null, surfaced as a failed
      // exchange by the null-check that follows.
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
    fail(
      503,
      "cloud_unreachable",
      "Eliza Cloud is unreachable",
      "We couldn't reach Eliza Cloud to verify your sign-in link. Try again in a minute.",
    );
    return true;
  }

  if (status === 401 || status === 403 || status === 410) {
    fail(
      403,
      "token_rejected",
      "Sign-in link expired",
      "Pairing links are single-use and only valid for a minute. Click 'Open Web UI' again from the dashboard.",
    );
    return true;
  }

  if (status === 429) {
    fail(
      429,
      "rate_limited",
      "Too many sign-in attempts",
      "Wait a minute and click 'Open Web UI' again from the dashboard.",
    );
    return true;
  }

  if (!exchanged || typeof exchanged.apiKey !== "string" || !exchanged.apiKey) {
    fail(
      502,
      "exchange_failed",
      "Sign-in failed",
      "Eliza Cloud accepted the link but did not return a key. Try again from the dashboard.",
    );
    return true;
  }

  logger.info(
    `[cloud-pair] exchange ok agent=${exchanged.agentName ?? "agent"} mode=${json ? "json" : "html"}`,
  );
  if (json) {
    sendJson(req, res, 200, {
      apiKey: exchanged.apiKey,
      ...(exchanged.agentName ? { agentName: exchanged.agentName } : {}),
    });
    return true;
  }
  sendHtml(res, 200, renderRedirectHtml(exchanged.apiKey));
  return true;
}
