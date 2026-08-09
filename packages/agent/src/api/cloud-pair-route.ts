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

/** API host -> the console host that actually serves `/dashboard/*` for the
 * SAME environment. A staging agent linking a user at the production console
 * (or at its own API origin, which serves no UI) is a dead link, so the
 * mapping is explicit rather than string-munged. A `Map` rather than an object
 * literal because the lookup key is a parsed hostname: `constructor` and
 * `__proto__` resolve to inherited members on an object literal and would
 * return a non-origin value that bypasses the canonicalization below. */
const CLOUD_CONSOLE_ORIGIN_BY_API_HOST = new Map<string, string>([
  ["api.elizacloud.ai", "https://www.elizacloud.ai"],
  ["api-staging.elizacloud.ai", "https://staging.elizacloud.ai"],
]);

const PRODUCTION_CONSOLE_ORIGIN = "https://www.elizacloud.ai";

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Console origin for the environment this agent is actually attached to.
 *
 * The configured base URL is untrusted input that ends up inside an `href`, so
 * parseability alone is not a safety property: `javascript:` parses fine, and
 * credentials/path/query in a configured URL must never reach the attribute.
 * Only an https origin (or loopback http, for self-hosted development) becomes
 * a clickable link, and always as the parser's canonical `origin` rather than
 * the raw configured string. Anything else falls back to the production
 * console, which is a dead-but-harmless link rather than a scriptable one.
 */
function resolveCloudConsoleOrigin(): string {
  let url: URL;
  try {
    url = new URL(resolveCloudAuthRoot());
  } catch {
    // error-policy:J3 a malformed configured base URL is untrusted input; a
    // known-safe origin is the only defensible default for a rendered link.
    return PRODUCTION_CONSOLE_ORIGIN;
  }

  const mapped = CLOUD_CONSOLE_ORIGIN_BY_API_HOST.get(
    url.hostname.toLowerCase(),
  );
  if (mapped) return mapped;

  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    return url.origin;
  }

  return PRODUCTION_CONSOLE_ORIGIN;
}

/**
 * Attribute-context escaping. `escapeHtml` covers text nodes only and leaves
 * quotes intact, which would let a quote-bearing value break out of an
 * attribute even after the origin allowlist above.
 */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
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
        function persist(storage) {
          try {
            storage.setItem("eliza:cloud-pair:api-token", key);
            return true;
          } catch (_storageError) {
            return false;
          }
        }
        var storedInSession = persist(window.sessionStorage);
        var storedDurably = persist(window.localStorage);
        if (!(storedInSession || storedDurably)) {
          throw new Error("No browser storage accepted the paired token.");
        }
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
    <a href="${escapeHtmlAttribute(`${resolveCloudConsoleOrigin()}/dashboard/agents`)}" target="_top" rel="noopener">Back to Eliza Cloud</a>
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
  let nonOkExchange = false;
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
      exchanged = (await response
        .json()
        .catch(() => null)) as PairResponse | null;
    } else {
      // The rejection branches below own the diagnostic for the statuses they
      // handle; a second generic line here would double-report the same event.
      nonOkExchange = true;
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
    // Cloud answers the same opaque "Invalid or expired pairing code" for an
    // expired token, an unknown one, an origin the token is not bound to, and
    // a cross-environment mint. Asserting expiry to the user sends them to
    // retry a link that was never the problem — the app-host dead-end (#18178)
    // was diagnosed only after proving the rejected token was seconds old.
    // Keep the copy about what is actually known, and put the upstream status
    // and the exchange origin in the log so the next report is actionable.
    // Structured context, never the token itself: the pairing token is a
    // single-use credential and must not reach logs.
    logger.warn(
      { status, exchangeUrl, requestOrigin: origin },
      "[cloud-pair] exchange rejected the pairing token",
    );
    sendHtml(
      res,
      403,
      renderErrorHtml(
        "Sign-in link could not be verified",
        "Eliza Cloud did not accept this sign-in link. It may have already been used, or it may have expired — pairing links are single-use and short-lived. Open your agent again from Eliza Cloud to get a fresh one.",
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
    // Covers both an unhandled non-2xx (500s, gateway errors) and a 2xx whose
    // body lacked the key. Same structured shape as the rejection branch so
    // one query surfaces every failed exchange; never logs the token.
    logger.warn(
      { status, exchangeUrl, requestOrigin: origin, nonOkExchange },
      "[cloud-pair] exchange did not yield an agent credential",
    );
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
