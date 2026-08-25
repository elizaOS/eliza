/**
 * Typed fetch wrapper for the cloud surfaces hosted inside the Eliza app.
 * Every `/api/*` call routed through here gets a single place that:
 *
 * - injects credentials (the steward-token cookie + `Authorization: Bearer`
 *   from localStorage when present)
 * - resolves the API base URL (same-origin in web browsers, the single
 *   allowlisted Eliza Cloud API host on native/Electrobun, configured base URL
 *   only in SSR/scripts)
 * - throws structured {@link ApiError} on non-2xx responses
 *
 * On a native (Capacitor) or Electrobun runtime the dashboard's WebView origin
 * is a synthetic bundle host (`https://localhost`, `file:`, …) with the embedded
 * LOCAL agent behind it — NOT Eliza Cloud. A same-origin `/api/*` call would hit
 * that local agent. So on those runtimes ONLY, this transport resolves requests
 * to the single allowlisted Cloud API host and routes them via `CapacitorHttp`
 * (the same bridge the agent client uses, see `../../api/client-cloud.ts`),
 * which bypasses the WebView CORS sandbox. The web path stays byte-identical:
 * same-origin relative URLs over `fetch`, and a hard throw on any cross-origin
 * absolute URL.
 *
 * Usage:
 *   const me = await api<MeResponse>("/api/users/me");
 *   await api("/api/v1/apps/123", { method: "DELETE" });
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { getElizaApiToken } from "@elizaos/shared";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { readCsrfTokenFromCookie } from "../../api/auth/csrf-cookie";
import { CSRF_HEADER_NAME } from "../../api/auth/sessions";
import { desktopHttpTransportForUrl } from "../../api/desktop-http-transport";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  resolveDirectCloudAuthApiBase,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
} from "../../api/direct-cloud-endpoints";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { getBootConfig } from "../../config/boot-config";
import { normalizeCloudApiKeyToken } from "./cloud-api-key-token";
import { decodeJwtPayload } from "./jwt";

// The single Eliza Cloud API host the native/Electrobun transport is allowed to
// reach cross-origin. Kept deliberately narrow: only this exact host relaxes the
// same-origin throw — every other absolute cross-origin URL still throws.
const ELIZA_CLOUD_API_HOSTS = new Set([
  new URL(DEFAULT_DIRECT_CLOUD_API_BASE_URL).hostname,
  new URL(STAGING_DIRECT_CLOUD_API_BASE_URL).hostname,
]);
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * True only inside a native (Capacitor iOS/Android) or Electrobun desktop
 * runtime — the surfaces whose WebView origin is NOT Eliza Cloud. Reuses the
 * existing runtime detectors (no new probes). On the web this is always false,
 * so every web code path below is unchanged.
 */
function isNativeCloudRuntime(): boolean {
  return Capacitor.isNativePlatform() || isElectrobunRuntime();
}

/**
 * Resolve the absolute Eliza Cloud API base for the native/Electrobun transport,
 * from `getBootConfig().cloudApiBase` (falling back to the production API host).
 * A configured web/auth host is normalized to the API host so relative
 * `/api/*` paths resolve onto the allowlisted Cloud API origin.
 */
function resolveNativeCloudApiBase(): string {
  const configured =
    getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_API_BASE_URL;
  return resolveDirectCloudAuthApiBase(configured);
}

/** The single allowlisted cross-origin Cloud API target (https + exact host). */
function isAllowlistedCloudApiHost(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    ELIZA_CLOUD_API_HOSTS.has(url.hostname.toLowerCase())
  );
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getApiBaseUrl(): string {
  // Native/Electrobun: the dashboard's WebView origin (`https://localhost`,
  // `file:`, …) fronts the embedded LOCAL agent, not Eliza Cloud, so a
  // same-origin `/api/*` call would hit the wrong backend. Resolve to the single
  // allowlisted Cloud API host instead (requests then ride `CapacitorHttp`).
  if (isNativeCloudRuntime()) return resolveNativeCloudApiBase();

  // Deliberately same-origin-only in the (web) browser: every `/api/*` call rides
  // the page's own origin so the steward-token cookie + Bearer header stay scoped
  // to Eliza Cloud. There is intentionally NO cross-origin fetch bridge here;
  // `resolveApiUrl` below enforces this by throwing on any cross-origin URL.
  if (typeof window !== "undefined") return "";

  const fromEnv =
    import.meta.env.VITE_API_URL ?? import.meta.env.NEXT_PUBLIC_API_URL;
  if (typeof fromEnv === "string" && fromEnv.length > 0)
    return fromEnv.replace(/\/+$/, "");
  return "";
}

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    const parsed = new URL(path);
    if (typeof window !== "undefined") {
      // Native/Electrobun ONLY: allow an absolute URL when — and only when — it
      // targets the single allowlisted Cloud API host. Every other cross-origin
      // absolute URL still throws, on native exactly as on web, so this never
      // opens a general cross-origin bridge.
      if (isNativeCloudRuntime() && isAllowlistedCloudApiHost(parsed)) {
        return path;
      }
      if (parsed.origin !== window.location.origin) {
        throw new ApiError(
          0,
          "CROSS_ORIGIN_API_URL",
          "Browser API calls must use same-origin paths so auth cookies and tokens stay scoped to Eliza Cloud.",
        );
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return path;
  }

  if (!path.startsWith("/")) {
    throw new ApiError(0, "INVALID_API_PATH", "API paths must start with '/'.");
  }

  return `${getApiBaseUrl()}${path}`;
}

function readStewardToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STEWARD_TOKEN_KEY);
  } catch {
    // error-policy:J3 storage unavailable reads as signed-out (fail-closed).
    return null;
  }
}

/**
 * Delete the stored Steward JWT if it is still the one being retired, then
 * only broadcast logout once the delete actually succeeded. `clearStoredStewardToken()`
 * is async and can reject (a native/Electrobun protected-storage delete can be
 * denied), so this awaits it: a denied delete must never announce "cleared" —
 * that would tell every listener the credential is gone while it is still
 * live in protected storage.
 */
async function clearStoredStewardTokenIfCurrent(token: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (readStoredStewardToken() !== token) return;
  try {
    await clearStoredStewardToken();
  } catch (error) {
    logger.error(
      { error },
      "[api-client] denied delete left the expired Steward JWT in storage; not broadcasting logout",
    );
    return;
  }
  window.dispatchEvent(new CustomEvent("steward-token-sync"));
}

async function readLiveNativeStewardToken(
  token: string,
): Promise<string | null> {
  const claims = decodeJwtPayload(token);
  const expMs = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  if (!claims || expMs === null || expMs <= Date.now()) {
    await clearStoredStewardTokenIfCurrent(token);
    return null;
  }
  return token;
}

/**
 * Resolve the Cloud bearer for the auth header. The Steward session JWT stays
 * first (canonical, unchanged). On native/Electrobun ONLY, fall back to the
 * owner cloud API key: device-code sign-in never writes `STEWARD_TOKEN_KEY` —
 * it stores the cloud API key on the agent client, which mirrors it into boot
 * config (see `ElizaClient.setToken`). So
 * without this fallback every native Apps API call left the WebView with NO
 * Authorization header and 401'd (#11930). The chain mirrors the canonical
 * `getCloudAuthToken()` in `../../api/client-cloud.ts` (steward JWT → owner cloud
 * API key), read here from boot config because this module has no client handle.
 * The Cloud API accepts both a Steward JWT and the owner API key. On web the
 * fallback never applies — it resolves to the steward token or nothing.
 *
 * Async because an expired native JWT must go through the awaited protected-
 * storage delete (`readLiveNativeStewardToken` →
 * `clearStoredStewardTokenIfCurrent`) before this resolves, so a denied delete
 * is observed here rather than raced past.
 */
export async function readCloudBearerToken(): Promise<string | null> {
  const nativeRuntime = isNativeCloudRuntime();
  // Resolve the supported owner-key fallback before expiry cleanup dispatches
  // the canonical session-clear event. That event may synchronously remove the
  // rejected account target from boot config; the already-validated fallback
  // must remain usable for this request on native/Electrobun (#11930).
  const nativeCloudApiKey = nativeRuntime
    ? (normalizeCloudApiKeyToken(getBootConfig().apiToken) ??
      normalizeCloudApiKeyToken(getElizaApiToken()))
    : null;
  const stewardToken = readStewardToken()?.trim();
  if (stewardToken) {
    if (!nativeRuntime) return stewardToken;
    const liveToken = await readLiveNativeStewardToken(stewardToken);
    if (liveToken) return liveToken;
  }
  return nativeCloudApiKey;
}

// ---------------------------------------------------------------------------
// Capacitor transport — routes the resolved Cloud API request through
// `CapacitorHttp` (bypassing the WebView CORS sandbox) and re-wraps the result
// as a standard `Response`, so the shared payload/error handling below is
// identical to the web `fetch` path.
// ---------------------------------------------------------------------------

const NATIVE_BODYLESS_STATUSES = new Set([204, 205, 304]);

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** CapacitorHttp wants a structured `data` value; parse a JSON string body back
 *  to an object, pass other bodies through, treat empty/absent as no body. */
function nativeRequestData(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body !== "string") return body;
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return body;
  }
}

function nativeResponseBody(data: unknown): {
  body: string;
  contentType: string;
} {
  if (data === null || data === undefined) {
    return { body: "", contentType: "application/json" };
  }
  if (typeof data === "string") {
    return { body: data, contentType: "text/plain" };
  }
  try {
    return { body: JSON.stringify(data), contentType: "application/json" };
  } catch {
    return { body: String(data), contentType: "text/plain" };
  }
}

function nativeResponseHeaders(
  raw: Record<string, string> | undefined,
  fallbackContentType: string,
): Headers {
  const headers = new Headers();
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      try {
        headers.set(key, value);
      } catch {
        // Skip a header CapacitorHttp surfaced that the WHATWG Headers
        // constructor rejects (rare; never let it break payload reading).
      }
    }
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", fallbackContentType);
  }
  return headers;
}

async function nativeApiFetch(
  url: string,
  init: { method?: string; headers: Headers; body?: BodyInit | null },
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const data = nativeRequestData(init.body);
  const result = await CapacitorHttp.request({
    url,
    method,
    headers: headersToRecord(init.headers),
    ...(data !== undefined ? { data } : {}),
    responseType: "json",
    connectTimeout: 30_000,
    readTimeout: 30_000,
  });
  const { body, contentType } = nativeResponseBody(result.data);
  return new Response(
    NATIVE_BODYLESS_STATUSES.has(result.status) ? null : body,
    {
      status: result.status,
      headers: nativeResponseHeaders(result.headers, contentType),
    },
  );
}

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  /** JSON body — automatically serialized + Content-Type applied. */
  json?: unknown;
  /** Raw body (string / FormData / Blob). Mutually exclusive with `json`. */
  body?: BodyInit | null;
  /** Skip steward token injection (e.g. for the steward-session endpoint itself). */
  skipAuth?: boolean;
}

async function readPayload(
  res: Response,
  strictJson: boolean,
): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  if (!isJson) {
    const text = await res.text();
    if (strictJson) {
      throw new ApiError(
        res.status,
        "NON_JSON_RESPONSE",
        text.trim().startsWith("<")
          ? `API returned HTML instead of JSON with status ${res.status}`
          : `API returned a non-JSON response with status ${res.status}`,
        text,
      );
    }
    return text;
  }

  try {
    return await res.json();
  } catch {
    if (strictJson) {
      throw new ApiError(
        res.status,
        "INVALID_JSON_RESPONSE",
        `API returned invalid JSON with status ${res.status}`,
      );
    }
    return null;
  }
}

function errorDetails(
  payload: unknown,
  status: number,
): { code: string; message: string } {
  if (typeof payload === "object" && payload !== null) {
    const body = payload as Record<string, unknown>;
    const message =
      (typeof body.error === "string" && body.error) ||
      (typeof body.message === "string" && body.message) ||
      `Request failed with status ${status}`;
    const code =
      typeof body.code === "string" && body.code ? body.code : `HTTP_${status}`;
    return { code, message };
  }

  if (typeof payload === "string" && payload) {
    const trimmed = payload.trim();
    const message = trimmed.startsWith("<")
      ? `Request failed with status ${status}; API returned a non-JSON response`
      : truncateWellFormed(toWellFormedUnicode(trimmed), 500);
    return { code: `HTTP_${status}`, message };
  }

  return {
    code: `HTTP_${status}`,
    message: `Request failed with status ${status}`,
  };
}

export async function apiFetch(
  path: string,
  init: ApiRequestInit = {},
): Promise<Response> {
  const { json, body, skipAuth, headers: rawHeaders, ...rest } = init;

  const headers = new Headers(rawHeaders);
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!skipAuth) {
    const token = await readCloudBearerToken();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  // Browser cookie sessions require the readable CSRF cookie to be mirrored
  // into the mutation header. Native/Electrobun calls are bearer-only and must
  // not forward a synthetic WebView origin's cookie to Eliza Cloud.
  const method = (rest.method ?? "GET").toUpperCase();
  if (
    !isNativeCloudRuntime() &&
    STATE_CHANGING_METHODS.has(method) &&
    !headers.has(CSRF_HEADER_NAME)
  ) {
    const csrfToken = readCsrfTokenFromCookie();
    if (csrfToken) headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  const url = resolveApiUrl(path);
  const requestBody =
    json !== undefined ? JSON.stringify(json) : (body ?? null);

  // Electrobun has its own main-process HTTP bridge; CapacitorHttp is not
  // installed in the macOS shell and otherwise falls back to a CORS-blocked
  // WKWebView request. Capacitor keeps its native plugin, while web retains the
  // original same-origin fetch path.
  const desktopTransport = desktopHttpTransportForUrl(url);
  const res = desktopTransport
    ? await desktopTransport.request(
        url,
        { ...rest, headers, body: requestBody },
        undefined,
      )
    : Capacitor.isNativePlatform()
      ? await nativeApiFetch(url, {
          method: rest.method,
          headers,
          body: requestBody,
        })
      : await fetch(url, {
          ...rest,
          credentials: "include",
          headers,
          body: requestBody,
        });

  if (!res.ok) {
    // A 401 on an authed call means our session was rejected (token revoked or
    // expired out from under the proactive refresh). Nudge the Steward runtime
    // to refresh-or-clear so a stale session self-heals instead of leaving the
    // UI "authed" until the next interaction. The nudge is a side effect only:
    // the call still throws ApiError, and the listener is single-flight and
    // never retries the request.
    if (res.status === 401 && !skipAuth && typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent("steward-unauthorized"));
      } catch {
        // no-op: event dispatch is best-effort
      }
    }
    const payload = await readPayload(res, false);
    const { code, message } = errorDetails(payload, res.status);
    throw new ApiError(res.status, code, message, payload);
  }

  return res;
}

export async function api<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
): Promise<T> {
  const res = await apiFetch(path, init);
  const payload = await readPayload(res, true);

  return payload as T;
}

/** Result of {@link apiWithStatus}: the raw HTTP status plus the parsed body. */
export interface ApiStatusResult<T> {
  status: number;
  data: T;
}

/**
 * Status-aware variant of {@link api} for endpoints whose HTTP status IS the
 * protocol — e.g. the agent provision/suspend job endpoints, where **202**
 * means "accepted, job queued (poll the jobId)" and **409** means "an
 * equivalent job is already in flight (attach to it)". Resolves with
 * `{ status, data }` for every response the server produced instead of
 * throwing on non-2xx, so callers branch on the status directly. Rides
 * {@link apiFetch}, so auth (steward cookie + `Authorization: Bearer`),
 * transport selection, and the 401 session nudge are identical to `api`.
 *
 * Only real HTTP responses resolve: transport/URL-policy failures (the
 * status-0 `ApiError`s from `resolveApiUrl`) and network errors still throw.
 * The body is read leniently (a non-JSON body resolves as its text) because
 * status-branching callers inspect payload fields defensively.
 */
export async function apiWithStatus<T = unknown>(
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiStatusResult<T>> {
  try {
    const res = await apiFetch(path, init);
    return { status: res.status, data: (await readPayload(res, false)) as T };
  } catch (err) {
    // error-policy:J1 boundary translation — apiFetch throws ApiError for every
    // non-2xx HTTP response (carrying the parsed body); re-shape it into the
    // typed { status, data } result this variant promises. Non-HTTP failures
    // (status 0 URL-policy throws, network TypeErrors) rethrow untouched.
    if (err instanceof ApiError && err.status > 0) {
      return { status: err.status, data: err.body as T };
    }
    throw err;
  }
}
