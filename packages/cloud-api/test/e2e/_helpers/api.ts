/**
 * Worker-targeted e2e API client.
 *
 * Mirrors `cloud/packages/tests/e2e/helpers/api-client.ts` but is local to
 * `apps/api` so foundation tests do not have to reach across packages.
 *
 * Configuration (env):
 *   TEST_API_BASE_URL  — defaults to TEST_BASE_URL, then http://localhost:8787
 *                        (wrangler dev). Set this to point tests at a running
 *                        Worker.
 *   TEST_API_KEY       — bootstrapped by `ensureLocalTestAuth()` in preload.
 *   CRON_SECRET        — for cron-route tests; defaults to "test-cron-secret".
 *
 * The helpers throw if you call them before `ensureLocalTestAuth()` has run.
 * The simplest preload is `cloud/packages/tests/e2e/preload.ts`, which seeds
 * the DB and exports `TEST_API_KEY`.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export function getBaseUrl(): string {
  return (
    process.env.TEST_API_BASE_URL?.trim() ||
    process.env.TEST_BASE_URL?.trim() ||
    "http://localhost:8787"
  );
}

export function url(path: string): string {
  return `${getBaseUrl()}${path}`;
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export function getApiKey(): string {
  const key = process.env.TEST_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TEST_API_KEY is not set. Run with the e2e preload " +
        "(packages/tests/e2e/preload.ts) so ensureLocalTestAuth() seeds the DB " +
        "and exports the bootstrapped key.",
    );
  }
  return key;
}

export function getMemberApiKey(): string {
  const key = process.env.TEST_MEMBER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TEST_MEMBER_API_KEY is not set. Run with the e2e preload " +
        "(packages/tests/e2e/preload.ts) so ensureLocalTestAuth() seeds the DB " +
        "and exports the bootstrapped member key.",
    );
  }
  return key;
}

export function bearerHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}

export function memberBearerHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getMemberApiKey()}`,
    "Content-Type": "application/json",
  };
}

export function getAffiliateApiKey(): string {
  // Fall back to the regular bootstrapped key when the preload didn't seed a
  // separate affiliate user — the affiliate group reuses the same auth path.
  const key = process.env.TEST_AFFILIATE_API_KEY?.trim() ?? process.env.TEST_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "TEST_AFFILIATE_API_KEY (or TEST_API_KEY) is not set. Run with the e2e preload " +
        "(packages/tests/e2e/preload.ts) so ensureLocalTestAuth() seeds the DB " +
        "and exports the bootstrapped affiliate key.",
    );
  }
  return key;
}

export function affiliateBearerHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getAffiliateApiKey()}`,
    "Content-Type": "application/json",
  };
}

export function apiKeyHeaders(): Record<string, string> {
  return {
    "X-API-Key": getApiKey(),
    "Content-Type": "application/json",
  };
}

export function cronHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.CRON_SECRET ?? "test-cron-secret"}`,
    "Content-Type": "application/json",
  };
}

export interface FetchOptions {
  headers?: Record<string, string>;
  body?: unknown;
}

async function request(method: string, path: string, opts: FetchOptions = {}): Promise<Response> {
  const init: RequestInit = {
    method,
    signal: timeoutSignal(),
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] ??= "application/json";
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return fetch(url(path), init);
}

export const api = {
  get: (path: string, opts?: FetchOptions) => request("GET", path, opts),
  post: (path: string, body?: unknown, opts?: FetchOptions) =>
    request("POST", path, { ...opts, body }),
  put: (path: string, body: unknown, opts?: FetchOptions) =>
    request("PUT", path, { ...opts, body }),
  patch: (path: string, body: unknown, opts?: FetchOptions) =>
    request("PATCH", path, { ...opts, body }),
  delete: (path: string, opts?: FetchOptions) => request("DELETE", path, opts),
};

/**
 * Probe `/api/health` to confirm the target server is up. Returns true if it
 * answers 2xx within 5 seconds. Used by tests to skip cleanly when the
 * Worker isn't running.
 */
export async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(url("/api/health"), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok && process.env.REQUIRE_E2E_SERVER !== "0") {
      throw new Error(`GET ${url("/api/health")} returned ${res.status}`);
    }
    return res.ok;
  } catch (error) {
    if (process.env.REQUIRE_E2E_SERVER !== "0") {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Worker e2e target is not reachable at ${getBaseUrl()}: ${message}`);
    }
    return false;
  }
}

/**
 * Exchange the bootstrapped API key for a session cookie via
 * `POST /api/test/auth/session`. The Worker must have `PLAYWRIGHT_TEST_AUTH=true`
 * in its env for this to be enabled.
 *
 * Returns `Cookie` header value ready to attach to subsequent requests.
 */
export async function exchangeApiKeyForSession(): Promise<string> {
  const res = await api.post("/api/test/auth/session", undefined, {
    headers: bearerHeaders(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /api/test/auth/session failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { token?: string; cookieName?: string };
  if (!json.token) {
    throw new Error("Test session response missing token");
  }
  const name = json.cookieName ?? "eliza-test-session";
  return `${name}=${json.token}`;
}
