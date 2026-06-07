/**
 * "Sign in with Eliza Cloud" — client helpers for third-party apps.
 *
 * Lets any app authenticate its users through Eliza Cloud with a small,
 * dependency-free authorization-code flow:
 *
 *   1. Redirect the user to the consent page:
 *        buildAppAuthorizeUrl({ appId, redirectUri, state })
 *      → https://www.elizacloud.ai/app-auth/authorize?app_id=…&redirect_uri=…&state=…
 *
 *   2. Eliza Cloud redirects back to `redirectUri` with a one-time code:
 *        success: <redirectUri>?code=eac_…&state=…
 *        denied:  <redirectUri>?error=access_denied&error_description=…&state=…
 *      Read it with parseAppAuthorizeCallback(window.location).
 *
 *   3. Exchange the code (server-side recommended) for the user:
 *        exchangeAppAuthorizeCode(code)
 *      → GET /api/v1/app-auth/session  (Authorization: Bearer eac_…)
 *      → { user: { id, email, name, avatar, createdAt }, app }
 *
 * The code is opaque (`eac_` prefix), single-use, and expires in 5 minutes.
 * There is no PKCE on this flow — the consent step is gated by the user's
 * existing Eliza Cloud session, and `redirect_uri` is validated against the
 * app's registered allowed origins.
 */

import {
  DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  DEFAULT_ELIZA_CLOUD_BASE_URL,
} from "../types.js";

/** Path of the hosted consent page (relative to the site base URL). */
export const APP_AUTH_AUTHORIZE_PATH = "/app-auth/authorize";
/** Path of the code-exchange endpoint (relative to the API base URL). */
export const APP_AUTH_SESSION_PATH = "/app-auth/session";
/** Prefix every Eliza Cloud app-auth code carries. */
export const APP_AUTH_CODE_PREFIX = "eac_";

/** True when `value` looks like an Eliza Cloud app-auth code (`eac_…`). */
export function looksLikeAppAuthCode(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && value.startsWith(APP_AUTH_CODE_PREFIX);
}

export interface BuildAppAuthorizeUrlOptions {
  /** The app's UUID, as registered with Eliza Cloud. */
  appId: string;
  /** Where Eliza Cloud sends the user back. Must be a registered origin. */
  redirectUri: string;
  /** Opaque value echoed back on the callback for CSRF protection. */
  state?: string;
  /** Site origin hosting the consent page. Defaults to www.elizacloud.ai. */
  baseUrl?: string;
}

/**
 * Build the URL to redirect a user to so they can authorize your app.
 * Mirrors the params the hosted consent page reads (`app_id`, `redirect_uri`,
 * `state`).
 */
export function buildAppAuthorizeUrl(
  options: BuildAppAuthorizeUrlOptions,
): string {
  const { appId, redirectUri, state, baseUrl } = options;
  if (!appId) throw new TypeError("buildAppAuthorizeUrl: appId is required");
  if (!redirectUri) {
    throw new TypeError("buildAppAuthorizeUrl: redirectUri is required");
  }
  const base = trimTrailingSlash(baseUrl ?? DEFAULT_ELIZA_CLOUD_BASE_URL);
  const url = new URL(`${base}${APP_AUTH_AUTHORIZE_PATH}`);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (state != null) url.searchParams.set("state", state);
  return url.toString();
}

export interface AppAuthorizeCallback {
  /** The one-time `eac_` code on success, else null. */
  code: string | null;
  /** The `state` value echoed back, if any. */
  state: string | null;
  /** The error code on denial/failure (e.g. `access_denied`), else null. */
  error: string | null;
  /** Human-readable error detail, if any. */
  errorDescription: string | null;
}

/**
 * Parse the callback Eliza Cloud redirected to. Accepts a full URL string, a
 * `URL`, a `URLSearchParams`, or a raw query string (with or without `?`).
 * In a browser you can pass `window.location`.
 */
export function parseAppAuthorizeCallback(
  input: string | URL | URLSearchParams | { search: string } | Location,
): AppAuthorizeCallback {
  const params = toSearchParams(input);
  return {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

/** A user as returned by the Eliza Cloud app-auth session endpoint. */
export interface ElizaCloudUser {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  createdAt: string | null;
}

/** The app the code was issued for, when resolvable. */
export interface ElizaCloudAppInfo {
  id: string;
  name: string;
}

export interface AppAuthSession {
  user: ElizaCloudUser;
  app: ElizaCloudAppInfo | null;
}

/** Thrown when the code exchange is rejected by Eliza Cloud. */
export class ElizaCloudAuthError extends Error {
  readonly statusCode: number;
  readonly code: string | null;
  constructor(message: string, statusCode: number, code: string | null = null) {
    super(message);
    this.name = "ElizaCloudAuthError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ExchangeAppAuthorizeCodeOptions {
  /** API base URL. Defaults to https://api.elizacloud.ai/api/v1. */
  apiBaseUrl?: string;
  /** Bind the exchange to a specific app id (sent as `X-App-Id`). */
  appId?: string;
  /** Inject a custom fetch (e.g. for tests or non-global runtimes). */
  fetchImpl?: typeof fetch;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

/**
 * Exchange a one-time `eac_` code for the signed-in Eliza Cloud user. The code
 * is consumed on first use. Run this server-side so the code never sits in a
 * browser. Throws `ElizaCloudAuthError` on a non-2xx response.
 */
export async function exchangeAppAuthorizeCode(
  code: string,
  options: ExchangeAppAuthorizeCodeOptions = {},
): Promise<AppAuthSession> {
  if (!looksLikeAppAuthCode(code)) {
    throw new ElizaCloudAuthError(
      "Not a valid Eliza Cloud app-auth code (expected an `eac_` code).",
      400,
      "invalid_code",
    );
  }
  const apiBase = trimTrailingSlash(
    options.apiBaseUrl ?? DEFAULT_ELIZA_CLOUD_API_BASE_URL,
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    authorization: `Bearer ${code}`,
    accept: "application/json",
  };
  if (options.appId) headers["x-app-id"] = options.appId;

  const response = await fetchImpl(`${apiBase}${APP_AUTH_SESSION_PATH}`, {
    method: "GET",
    headers,
    signal: options.signal,
  });

  const body = (await response.json().catch(() => null)) as
    | AppAuthSessionResponse
    | CloudErrorShape
    | null;

  if (
    !response.ok ||
    !body ||
    (body as AppAuthSessionResponse).success !== true
  ) {
    const { message, code: errCode } = readError(body, response.status);
    throw new ElizaCloudAuthError(message, response.status, errCode);
  }

  const ok = body as AppAuthSessionResponse;
  return { user: ok.user, app: ok.app ?? null };
}

export interface ElizaCloudAppAuthOptions {
  /** The app's UUID, as registered with Eliza Cloud. */
  appId: string;
  /** Where Eliza Cloud sends the user back. Must be a registered origin. */
  redirectUri: string;
  /** Site origin hosting the consent page. Defaults to www.elizacloud.ai. */
  baseUrl?: string;
  /** API base URL. Defaults to https://api.elizacloud.ai/api/v1. */
  apiBaseUrl?: string;
  /** Inject a custom fetch (e.g. for tests or non-global runtimes). */
  fetchImpl?: typeof fetch;
}

/**
 * Small stateful wrapper that binds `appId` + `redirectUri` once so you don't
 * repeat them. All methods delegate to the standalone functions above.
 */
export class ElizaCloudAppAuth {
  private readonly appId: string;
  private readonly redirectUri: string;
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ElizaCloudAppAuthOptions) {
    if (!options.appId)
      throw new TypeError("ElizaCloudAppAuth: appId is required");
    if (!options.redirectUri) {
      throw new TypeError("ElizaCloudAppAuth: redirectUri is required");
    }
    this.appId = options.appId;
    this.redirectUri = options.redirectUri;
    this.baseUrl = options.baseUrl ?? DEFAULT_ELIZA_CLOUD_BASE_URL;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_ELIZA_CLOUD_API_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Build the consent-page URL to redirect the user to. */
  authorizeUrl(state?: string): string {
    return buildAppAuthorizeUrl({
      appId: this.appId,
      redirectUri: this.redirectUri,
      state,
      baseUrl: this.baseUrl,
    });
  }

  /** Parse the callback Eliza Cloud redirected back to. */
  parseCallback(
    input: string | URL | URLSearchParams | { search: string } | Location,
  ): AppAuthorizeCallback {
    return parseAppAuthorizeCallback(input);
  }

  /** Exchange a raw `eac_` code for the user. */
  exchangeCode(
    code: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<AppAuthSession> {
    return exchangeAppAuthorizeCode(code, {
      apiBaseUrl: this.apiBaseUrl,
      appId: this.appId,
      fetchImpl: this.fetchImpl,
      signal: opts.signal,
    });
  }

  /**
   * Parse a callback and exchange its code in one step. Throws
   * `ElizaCloudAuthError` if the callback carries an error or no code.
   */
  async completeSignIn(
    input: string | URL | URLSearchParams | { search: string } | Location,
    opts: { signal?: AbortSignal } = {},
  ): Promise<AppAuthSession> {
    const cb = this.parseCallback(input);
    if (cb.error) {
      throw new ElizaCloudAuthError(
        cb.errorDescription ?? `Authorization failed: ${cb.error}`,
        400,
        cb.error,
      );
    }
    if (!cb.code) {
      throw new ElizaCloudAuthError(
        "No authorization code present on the callback URL.",
        400,
        "missing_code",
      );
    }
    return this.exchangeCode(cb.code, opts);
  }
}

// ── internals ───────────────────────────────────────────────────────────────

interface AppAuthSessionResponse {
  success: true;
  user: ElizaCloudUser;
  app?: ElizaCloudAppInfo | null;
}

interface CloudErrorShape {
  success?: false;
  error?: unknown;
  message?: unknown;
  code?: unknown;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toSearchParams(
  input: string | URL | URLSearchParams | { search: string } | Location,
): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (typeof input === "string") {
    // Accept a full URL, a "?a=b" query, or a bare "a=b" query.
    if (input.includes("://")) return new URL(input).searchParams;
    return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
  }
  // A Location-like object with a `.search` string.
  return new URLSearchParams(
    input.search.startsWith("?") ? input.search.slice(1) : input.search,
  );
}

function readError(
  body: AppAuthSessionResponse | CloudErrorShape | null,
  status: number,
): { message: string; code: string | null } {
  const fallback = `Eliza Cloud sign-in failed (HTTP ${status}).`;
  if (!body || typeof body !== "object")
    return { message: fallback, code: null };
  const err = (body as CloudErrorShape).error;
  const errObj = isRecord(err) ? err : null;
  const message =
    (typeof err === "string" ? err : undefined) ??
    (errObj && typeof errObj.message === "string"
      ? errObj.message
      : undefined) ??
    (typeof (body as CloudErrorShape).message === "string"
      ? ((body as CloudErrorShape).message as string)
      : undefined) ??
    fallback;
  const code =
    (errObj && typeof errObj.code === "string" ? errObj.code : undefined) ??
    (typeof (body as CloudErrorShape).code === "string"
      ? ((body as CloudErrorShape).code as string)
      : undefined) ??
    null;
  return { message, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
