/**
 * E2E API Client
 *
 * Typed HTTP client for API route tests using bun:test.
 * Provides auth-aware request methods plus assertion helpers.
 */

const SERVER_URL =
  process.env.TEST_BASE_URL || `http://localhost:${process.env.TEST_SERVER_PORT || "8787"}`;
const CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret";
let cachedSessionCookiePromise: Promise<string | null> | null = null;

function getApiKey(): string | null {
  const apiKey = process.env.TEST_API_KEY?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function hasNonEmptyEnv(name: string): boolean {
  const value = process.env[name]?.trim();
  return Boolean(value);
}

function getSessionCookie(): string | null {
  const token = process.env.TEST_SESSION_TOKEN?.trim();
  if (!token) {
    return null;
  }

  const cookieName = process.env.TEST_SESSION_COOKIE_NAME?.trim() || "eliza-test-session";
  return `${cookieName}=${token}`;
}

function authenticatedHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("TEST_API_KEY required");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "X-API-Key": apiKey,
    "Content-Type": "application/json",
  };

  const cookie = getSessionCookie();
  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
}

function isSessionOnlyPath(path: string): boolean {
  return path === "/api/v1/api-keys" || path.startsWith("/api/v1/api-keys/");
}

async function getSessionCookieFromServer(): Promise<string | null> {
  const existingCookie = getSessionCookie();
  if (existingCookie) {
    return existingCookie;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return null;
  }

  const response = await fetch(url("/api/test/auth/session"), {
    method: "POST",
    signal: timeoutSignal(),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create live test session: ${response.status} ${body.slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    cookieName?: string;
    token?: string;
  };

  if (!body.token) {
    throw new Error("Live test session response did not include a token");
  }

  const cookieName = body.cookieName || "eliza-test-session";
  const cookie = `${cookieName}=${body.token}`;
  process.env.TEST_SESSION_COOKIE_NAME = cookieName;
  process.env.TEST_SESSION_TOKEN = body.token;
  return cookie;
}

async function authenticatedRequestHeaders(path: string): Promise<Record<string, string>> {
  const headers = isSessionOnlyPath(path)
    ? { "Content-Type": "application/json" }
    : authenticatedHeaders();
  const cookie = await (cachedSessionCookiePromise ??= getSessionCookieFromServer());

  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
}

/** Auth headers for API key authentication */
export function authHeaders(): Record<string, string> {
  return authenticatedHeaders();
}

/** Headers for X-API-Key authentication */
export function apiKeyHeaders(): Record<string, string> {
  return authenticatedHeaders();
}

/** Headers for cron secret authentication */
export function cronHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${CRON_SECRET}`,
    "Content-Type": "application/json",
  };
}

/** Check if API key is available */
export function hasApiKey(): boolean {
  return !!getApiKey();
}

/** Check if a live AI provider is configured for inference-backed routes */
export function hasAiProvider(): boolean {
  return (
    hasNonEmptyEnv("OPENROUTER_API_KEY") ||
    hasNonEmptyEnv("OPENAI_API_KEY") ||
    hasNonEmptyEnv("ANTHROPIC_API_KEY") ||
    hasNonEmptyEnv("GROQ_API_KEY")
  );
}

/** Check if cron secret is available */
export function hasCronSecret(): boolean {
  return !!CRON_SECRET;
}

/** Chat full URL from path */
export function url(path: string): string {
  return `${SERVER_URL}${path}`;
}

/** Default request timeout in ms */
const REQUEST_TIMEOUT = 30_000;

/** Create AbortSignal with timeout */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT);
}

/** GET request with optional auth */
export async function get(
  path: string,
  options?: { authenticated?: boolean; headers?: Record<string, string> },
): Promise<Response> {
  const { authenticated = false, headers = {} } = options || {};
  return fetch(url(path), {
    method: "GET",
    signal: timeoutSignal(),
    headers: {
      ...(authenticated ? await authenticatedRequestHeaders(path) : {}),
      ...headers,
    },
  });
}

/** POST request with optional auth and body */
export async function post(
  path: string,
  body?: unknown,
  options?: { authenticated?: boolean; headers?: Record<string, string> },
): Promise<Response> {
  const { authenticated = false, headers = {} } = options || {};
  return fetch(url(path), {
    method: "POST",
    signal: timeoutSignal(),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? await authenticatedRequestHeaders(path) : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** PATCH request with auth and body */
export async function patch(
  path: string,
  body: unknown,
  options?: { authenticated?: boolean; headers?: Record<string, string> },
): Promise<Response> {
  const { authenticated = false, headers = {} } = options || {};
  return fetch(url(path), {
    method: "PATCH",
    signal: timeoutSignal(),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? await authenticatedRequestHeaders(path) : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** DELETE request with auth */
export async function del(
  path: string,
  options?: { authenticated?: boolean; headers?: Record<string, string> },
): Promise<Response> {
  const { authenticated = false, headers = {} } = options || {};
  return fetch(url(path), {
    method: "DELETE",
    signal: timeoutSignal(),
    headers: {
      ...(authenticated ? await authenticatedRequestHeaders(path) : {}),
      ...headers,
    },
  });
}

/** PUT request with auth and body */
export async function put(
  path: string,
  body: unknown,
  options?: { authenticated?: boolean; headers?: Record<string, string> },
): Promise<Response> {
  const { authenticated = false, headers = {} } = options || {};
  return fetch(url(path), {
    method: "PUT",
    signal: timeoutSignal(),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? await authenticatedRequestHeaders(path) : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Assertion helpers */
export async function expectJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Expected JSON, got ${contentType}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

/** Assert response status is one of expected values */
export function expectStatus(response: Response, ...expected: number[]): void {
  if (!expected.includes(response.status)) {
    throw new Error(
      `Expected status ${expected.join("|")}, got ${response.status} for ${response.url}`,
    );
  }
}
