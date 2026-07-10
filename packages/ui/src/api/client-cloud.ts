/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  readStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  type AgentReadinessProbe,
  type AuthedAgentFetch,
  startCloudConversationHandoff,
} from "../cloud/handoff/cloud-handoff-supervisor";
import { isRetryableHandoffHttpStatus } from "../cloud/handoff/conversation-handoff";
import { getBootConfig } from "../config/boot-config";
import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { ElizaClient } from "./client-base";
import type {
  ApiError,
  CloudApiKeySummary,
  CloudApiKeys,
  CloudBillingCheckoutRequest,
  CloudBillingCheckoutResponse,
  CloudBillingCryptoQuoteRequest,
  CloudBillingCryptoQuoteResponse,
  CloudBillingHistoryItem,
  CloudBillingPaymentMethod,
  CloudBillingSettings,
  CloudBillingSettingsUpdateRequest,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCompatAgentProvisionResponse,
  CloudCompatAgentStatus,
  CloudCompatDiscordConfig,
  CloudCompatJob,
  CloudCompatLaunchResult,
  CloudCompatManagedDiscordStatus,
  CloudCompatManagedGithubStatus,
  CloudCredits,
  CloudLoginPersistResponse,
  CloudLoginPollResponse,
  CloudLoginResponse,
  CloudOAuthConnection,
  CloudOAuthConnectionRole,
  CloudOAuthInitiateResponse,
  CloudStatus,
  CloudTwitterOAuthInitiateResponse,
  LocalAgentBackupMetadata,
  SandboxBrowserEndpoints,
  SandboxPlatformStatus,
  SandboxScreenshotPayload,
  SandboxScreenshotRegion,
  SandboxStartResponse,
  SandboxWindowInfo,
} from "./client-types";

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 4;
const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://elizacloud.ai";
const DEFAULT_DIRECT_CLOUD_API_BASE_URL = "https://api.elizacloud.ai";
const STAGING_DIRECT_CLOUD_BASE_URL = "https://staging.elizacloud.ai";
const STAGING_DIRECT_CLOUD_API_BASE_URL = "https://api-staging.elizacloud.ai";
const DIRECT_CLOUD_HTTP_TIMEOUT_MS = 15_000;
const DIRECT_ELIZA_CLOUD_API_BY_HOST = new Map([
  ["api.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["www.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["dev.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["app.elizacloud.ai", DEFAULT_DIRECT_CLOUD_API_BASE_URL],
  ["api-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
  ["app-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_API_BASE_URL],
]);
// Also normalizes non-API site hosts (www/app/dev -> apex): a browser
// navigation must never be pointed through the API worker or www redirect edge.
// The former serves JSON that mobile Safari can download as document.txt; the
// latter adds the redirect hop the owner capture attributed to www (#15143).
const DIRECT_ELIZA_CLOUD_WEB_BY_HOST = new Map([
  ["api.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["www.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["app.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["dev.elizacloud.ai", DEFAULT_DIRECT_CLOUD_BASE_URL],
  ["api-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
  ["staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
  ["app-staging.elizacloud.ai", STAGING_DIRECT_CLOUD_BASE_URL],
]);

type DirectCloudAgent = {
  id?: string;
  agentId?: string;
  agentName?: string;
  name?: string;
  status?: string;
  databaseStatus?: string;
  database_status?: string;
  bridgeUrl?: string | null;
  bridge_url?: string | null;
  webUiUrl?: string | null;
  web_ui_url?: string | null;
  apiBase?: string | null;
  api_base?: string | null;
  containerUrl?: string | null;
  container_url?: string | null;
  runtimeUrl?: string | null;
  runtime_url?: string | null;
  errorMessage?: string | null;
  error_message?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastHeartbeatAt?: string | null;
  last_heartbeat_at?: string | null;
  agentConfig?: Record<string, unknown>;
  agent_config?: Record<string, unknown>;
};

type DirectCloudJob = {
  id?: string;
  jobId?: string;
  job_id?: string;
  type?: string;
  status?: string;
  state?: string;
  phase?: string;
  data?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: unknown;
  message?: string | null;
  reason?: string | null;
  attempts?: number;
  retryCount?: number;
  retry_count?: number;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  createdAt?: string;
  created_at?: string;
};

type DirectCloudAgentCreateData = {
  id: string;
  agentName: string;
  status: string;
};

/** Async-job envelope returned by the restart/suspend/resume lifecycle routes. */
type LifecycleResult = { jobId: string; status: string; message: string };

function isCloudRouteNotFound(error: unknown): error is ApiError {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as ApiError).status === 404
  );
}

function originsMatch(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    // error-policy:J3 malformed URL input fails closed (no origin match).
    return false;
  }
}

function isDirectCloudBase(client: ElizaClient): boolean {
  const baseUrl = client.getBaseUrl().trim();
  if (!baseUrl) return false;

  const configuredCloudBase =
    getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_BASE_URL;
  if (originsMatch(baseUrl, configuredCloudBase)) return true;

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_API_BY_HOST.has(host);
  } catch {
    // error-policy:J3 malformed base URL reads as "not a direct cloud base".
    return false;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = stringOrNull(value);
    if (stringValue) return stringValue;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const numberValue = numberOrNull(value);
    if (numberValue !== null) return numberValue;
  }
  return null;
}

function directCloudLoginToken(data: unknown): string | null {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  // Prefer Steward/session tokens over the legacy API key field. Some Cloud
  // responses include both; using apiKey first can persist a token that lists
  // agents but fails unified agent restore/wake authorization.
  return firstString(
    root?.token,
    root?.accessToken,
    root?.stewardToken,
    root?.sessionToken,
    nested?.token,
    nested?.accessToken,
    nested?.stewardToken,
    nested?.sessionToken,
    root?.apiKey,
    nested?.apiKey,
  );
}

function directCloudLoginStringField(
  data: unknown,
  field: string,
  snakeField?: string,
): string | undefined {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  return (
    firstString(
      root?.[field],
      snakeField ? root?.[snakeField] : undefined,
      nested?.[field],
      snakeField ? nested?.[snakeField] : undefined,
    ) ?? undefined
  );
}

function normalizeCloudLoginPollStatus(
  value: unknown,
): "pending" | "authenticated" | "expired" | "error" {
  const status = stringOrNull(value)?.toLowerCase();
  if (
    status === "authenticated" ||
    status === "expired" ||
    status === "error" ||
    status === "pending"
  ) {
    return status;
  }
  return "pending";
}

function errorStringOrNull(value: unknown): string | null {
  const direct = stringOrNull(value);
  if (direct) return direct;
  const record = recordOrNull(value);
  if (!record) return null;
  return firstString(record.error, record.message, record.reason);
}

function parseCloudLoginPollData(data: unknown): {
  status: "pending" | "authenticated" | "expired" | "error";
  organizationId?: string;
  token?: string;
  userId?: string;
  error?: string;
} {
  const root = recordOrNull(data);
  const nested = recordOrNull(root?.data);
  const status = normalizeCloudLoginPollStatus(
    firstString(root?.status, nested?.status),
  );
  return {
    status,
    ...(status === "authenticated"
      ? {
          token: directCloudLoginToken(data) ?? undefined,
          organizationId: directCloudLoginStringField(
            data,
            "organizationId",
            "organization_id",
          ),
          userId: directCloudLoginStringField(data, "userId", "user_id"),
        }
      : {}),
    ...(status === "error"
      ? { error: errorStringOrNull(data) ?? "Poll request failed" }
      : {}),
  };
}

function generateCloudLoginSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function resolveCloudCliLoginReturnUrl(sessionId: string): string | null {
  if (shouldUseNativeCloudHttp() || typeof window === "undefined") return null;
  try {
    const { origin, pathname, protocol, search, hash } = window.location;
    if (protocol !== "http:" && protocol !== "https:") return null;
    const path =
      pathname.startsWith("/") &&
      !pathname.startsWith("//") &&
      !pathname.startsWith("/auth/cli-login")
        ? `${pathname}${search}${hash}`
        : "/chat";
    const url = new URL(path, origin);
    url.searchParams.set("elizaCloudLogin", "complete");
    url.searchParams.set("elizaCloudLoginSession", sessionId);
    return url.toString();
  } catch {
    // error-policy:J3 a malformed app URL just falls back to the existing
    // polling/close path; the Cloud page will keep its success fallback.
    return null;
  }
}

function buildCloudCliLoginBrowserUrl(
  cloudWebBase: string,
  sessionId: string,
): string {
  const url = new URL("/auth/cli-login", cloudWebBase);
  url.searchParams.set("session", sessionId);
  const returnTo = resolveCloudCliLoginReturnUrl(sessionId);
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}

function shouldUseNativeCloudHttp(): boolean {
  return Capacitor.isNativePlatform();
}

function shouldUseNativeStewardRefreshHttp(endpoint: string): boolean {
  if (!/^https?:\/\//i.test(endpoint)) return false;
  return Capacitor.isNativePlatform() || isElectrobunRuntime();
}

/**
 * True when the document is itself served from a known Eliza Cloud host, which
 * is the only place a cloud-API request can collapse to a same-origin path. The
 * cloud web host proxies `/api` to the worker; localhost dev, custom-scheme
 * WebViews, and third-party embeds do not.
 */
function isPageServedFromDirectCloudHost(): boolean {
  if (typeof window === "undefined") return false;
  return DIRECT_ELIZA_CLOUD_API_BY_HOST.has(
    window.location.hostname.toLowerCase(),
  );
}

function resolveBrowserCloudApiRequestUrl(url: string): string {
  if (shouldUseNativeCloudHttp() || typeof window === "undefined") return url;
  try {
    const parsed = new URL(url);
    if (!DIRECT_ELIZA_CLOUD_API_BY_HOST.has(parsed.hostname.toLowerCase())) {
      return url;
    }
    // Same-origin collapse is valid only for production co-hosting, where
    // app.elizacloud.ai proxies `/api` to the worker. On localhost dev, including
    // shifted Vite ports such as 2160, the same path targets the local agent API
    // and trips its default-deny gate for `/api/auth/*`. Keep the absolute cloud
    // URL there; the worker CORS allowlist covers localhost ports.
    if (!isPageServedFromDirectCloudHost()) {
      return url;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    // error-policy:J3 an unparseable URL is passed through unchanged — this
    // helper only rewrites known cloud hosts to same-origin paths.
    return url;
  }
}

/**
 * The browser-navigable Eliza Cloud WEB base for a configured cloud base URL
 * (API hosts map to their site host; www maps to the apex). Every URL handed
 * to a browser window/tab must be built on this — never on the raw configured
 * base, which can be an API host whose JSON responses mobile browsers download
 * as files instead of rendering (#15143).
 */
export function resolveDirectCloudWebBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_WEB_BY_HOST.get(host) ?? normalized;
  } catch {
    // Fall back to the provided base below.
  }
  return normalized;
}

export function resolveDirectCloudAuthApiBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    return DIRECT_ELIZA_CLOUD_API_BY_HOST.get(host) ?? normalized;
  } catch {
    // Fall back to the provided base below.
  }
  return normalized;
}

function resolveDirectCloudClientApiBase(client: ElizaClient): string | null {
  const baseUrl = client.getBaseUrl().trim();
  if (baseUrl && isDirectCloudBase(client)) {
    return resolveDirectCloudAuthApiBase(baseUrl);
  }
  if (shouldUseNativeCloudHttp()) {
    return resolveDirectCloudAuthApiBase(
      getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_BASE_URL,
    );
  }
  // Web SPA served from a cloud host with no agent baseUrl yet — exactly the
  // /join flow's state (selectOrProvisionCloudAgent runs BEFORE any agent
  // connection exists). Resolve the control plane from the page host so the
  // direct /api/v1 path works. Returning null here sent these calls down the
  // agent-proxy fallback (/api/cloud/compat/*), a route only agent servers
  // mount — the cloud worker 404s it, so every web sign-in dead-ended on
  // "Couldn't connect to your agent".
  //
  // Gate this on the empty-baseUrl state ONLY. Once the client is connected to
  // a NON-cloud agent server (baseUrl = an agent URL that isn't a direct-cloud
  // base — handled above), the direct-cloud call must go to that agent, not the
  // page host. Firing this branch while connected would mis-route to the cloud
  // host and 401. See PR #11448.
  if (!baseUrl && typeof window !== "undefined") {
    const byHost = DIRECT_ELIZA_CLOUD_API_BY_HOST.get(
      window.location.hostname.toLowerCase(),
    );
    if (byHost) return byHost;
  }
  return null;
}

/**
 * Resolve the Cloud auth bearer token. Per DECISIONS.md D3 the Cloud
 * connection is unified on Steward across every target (hosted web AND
 * native), so the Steward session JWT in `localStorage.steward_session_token`
 * is the canonical source. On web the same JWT also rides the same-origin
 * `steward-token` cookie; on native (`capacitor://localhost` / loopback) it is
 * sent as `Authorization: Bearer`.
 *
 * The Remote (device-code/pairing) flow mints its own session token via
 * `cloudLoginPollDirect` and persists it through the same steward-session store
 * (`writeStoredStewardToken`), so it resolves here through the canonical Steward
 * branch too. The client REST token is the last fallback.
 */
export function getCloudAuthToken(client?: ElizaClient): string | null {
  const stewardToken = readStoredStewardToken()?.trim();
  if (stewardToken) return stewardToken;

  const clientToken = client?.getRestAuthToken()?.trim();
  return clientToken || null;
}

function readDirectCloudToken(client: ElizaClient): string | null {
  return getCloudAuthToken(client);
}

/**
 * Decode a JWT `exp` (seconds until expiry), or `null` when the token is not a
 * JWT / has no `exp`. Used by the Cloud Steward token-lifecycle refresh.
 */
export function cloudTokenSecsRemaining(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(
      base64.length + ((4 - (base64.length % 4)) % 4),
      "=",
    );
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof payload.exp !== "number") return null;
    return payload.exp - Date.now() / 1000;
  } catch {
    // error-policy:J3 `null` is the explicit "no decodable exp" signal
    // (opaque/device-code tokens); callers skip lifecycle refresh for it.
    return null;
  }
}

/**
 * Cookie-backed Steward session refresh, mirroring cloud-frontend's
 * `AuthTokenSync` semantics. Sends an empty POST to the Steward refresh
 * endpoint with `credentials: "include"` so the HttpOnly
 * `steward-refresh-token` cookie travels automatically (web same-origin). The
 * server rotates the session and, for trusted Cloud origins / native callers,
 * returns the short-lived access token so the SPA can refresh its localStorage
 * Bearer mirror. Returns the fresh token when one was issued, else `null`.
 *
 * On native the same endpoint is reached via the configured cloud API base
 * (Bearer-refresh); the caller passes the absolute endpoint via `endpoint`.
 */
export async function refreshCloudStewardSession(opts?: {
  endpoint?: string;
}): Promise<{ token?: string; expiresAt?: number; expiresIn?: number } | null> {
  const endpoint = opts?.endpoint ?? STEWARD_REFRESH_ENDPOINT;
  if (shouldUseNativeStewardRefreshHttp(endpoint)) {
    const token = readStoredStewardToken()?.trim();
    if (!token) return null;
    const response = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url: endpoint,
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method: "POST", url: endpoint },
    );
    if (response.status < 200 || response.status >= 300) return null;
    return parseDirectCloudJsonSafe(response.data) as {
      token?: string;
      expiresAt?: number;
      expiresIn?: number;
    } | null;
  }

  if (typeof fetch === "undefined") return null;
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) return null;
  // error-policy:J3 an unparseable refresh body reads as "no refreshed
  // session" (null) — callers keep/drop the stored token by its own expiry.
  return (await response.json().catch(() => null)) as {
    token?: string;
    expiresAt?: number;
    expiresIn?: number;
  } | null;
}

function isNativeDirectCloudAuthMissing(client: ElizaClient): boolean {
  return (
    shouldUseNativeCloudHttp() &&
    Boolean(resolveDirectCloudClientApiBase(client)) &&
    !readDirectCloudToken(client)
  );
}

function nativeDirectCloudAuthMissingMessage(): string {
  return "Eliza Cloud login session is missing. Sign in again.";
}

function parseDirectCloudJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  if (!data.trim()) return {};
  return JSON.parse(data);
}

function parseDirectCloudJsonSafe(data: unknown): unknown {
  try {
    return parseDirectCloudJson(data);
  } catch {
    // error-policy:J3 non-JSON bodies (HTML error pages, plain text) are
    // returned raw so directCloudResponseText can quote them in the error.
    return data;
  }
}

function directCloudResponseText(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function directCloudBodyData(body: BodyInit | null | undefined): unknown {
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

async function withDirectCloudHttpTimeout<T>(
  request: Promise<T>,
  args: { method: string; url: string },
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Eliza Cloud request timed out after ${Math.round(
            DIRECT_CLOUD_HTTP_TIMEOUT_MS / 1000,
          )}s (${args.method} ${args.url})`,
        ),
      );
    }, DIRECT_CLOUD_HTTP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchDirectCloudWithTimeout(
  url: string,
  init: RequestInit,
  args: { method: string; url: string },
): Promise<Response> {
  const controller = new AbortController();
  let abortListener: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (init.signal) {
    if (init.signal.aborted) {
      throw new Error(
        `Eliza Cloud request aborted (${args.method} ${args.url})`,
      );
    }
    abortListener = () => controller.abort();
    init.signal.addEventListener("abort", abortListener, { once: true });
  }

  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DIRECT_CLOUD_HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Eliza Cloud request timed out after ${Math.round(
          DIRECT_CLOUD_HTTP_TIMEOUT_MS / 1000,
        )}s (${args.method} ${args.url})`,
      );
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (init.signal && abortListener) {
      init.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function directCloudJsonResponse<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T; text: string }> {
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  if (shouldUseNativeCloudHttp()) {
    const data = directCloudBodyData(init?.body);
    const res = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url,
        method,
        headers,
        ...(data !== undefined ? { data } : {}),
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method, url },
    );
    const parsed = parseDirectCloudJsonSafe(res.data) as T;
    return {
      ok: isAcceptableDirectCloudResponse(res.status, parsed),
      status: res.status,
      data: parsed,
      text: directCloudResponseText(res.data),
    };
  }

  const requestUrl = resolveBrowserCloudApiRequestUrl(url);
  const res = await fetchDirectCloudWithTimeout(
    requestUrl,
    { ...init, method, headers },
    { method, url },
  );
  const text = await res.text().catch(() => res.statusText);
  const parsed = parseDirectCloudJsonSafe(text) as T;
  return {
    ok: isAcceptableDirectCloudResponse(res.status, parsed),
    status: res.status,
    data: parsed,
    text,
  };
}

function directCloudResponseErrorMessage(
  status: number,
  body: unknown,
): string {
  let detail: string | null = null;
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const candidate = record.error ?? record.message ?? record.reason;
    if (typeof candidate === "string" && candidate.trim()) {
      detail = candidate.trim();
    }
  } else if (typeof body === "string" && body.trim()) {
    detail = body.trim();
  }
  return detail
    ? `Cloud request failed (${status}): ${detail}`
    : `Cloud request failed (${status})`;
}

async function directCloudRequest<T>(
  client: ElizaClient,
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const apiBase = resolveDirectCloudClientApiBase(client);
  if (!apiBase) return null;

  const token = readDirectCloudToken(client);
  if (!token) return null;

  const url = `${apiBase}${path}`;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });

  if (shouldUseNativeCloudHttp()) {
    const data = directCloudBodyData(init?.body);
    const res = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url,
        method,
        headers,
        ...(data !== undefined ? { data } : {}),
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      }),
      { method, url },
    );
    const parsed = parseDirectCloudJson(res.data) as T;
    if (!isAcceptableDirectCloudResponse(res.status, parsed)) {
      throw Object.assign(
        new Error(directCloudResponseErrorMessage(res.status, parsed)),
        {
          status: res.status,
          data: res.data,
          url,
        },
      );
    }
    return parsed;
  }

  const requestUrl = resolveBrowserCloudApiRequestUrl(url);
  const res = await fetchDirectCloudWithTimeout(
    requestUrl,
    { ...init, method, headers },
    { method, url },
  );
  const data = await res.json().catch(async () => ({
    error: await res.text().catch(() => res.statusText),
  }));
  if (!isAcceptableDirectCloudResponse(res.status, data)) {
    throw Object.assign(
      new Error(directCloudResponseErrorMessage(res.status, data)),
      {
        status: res.status,
        data,
        url,
      },
    );
  }
  return data as T;
}

/**
 * Eliza Cloud can report an idempotent provisioning resume as HTTP 409 while
 * returning a successful envelope with a useful jobId. The legacy strict-2xx
 * check threw on that body and stranded callers like `provisionAndConnect`
 * mid-await with no jobId, surfacing as an "infinite Starting provisioning..."
 * UI hang. Keep that specific resume shape acceptable without treating every
 * non-2xx `{ success: true }` body as healthy.
 */
function isAcceptableDirectCloudResponse(
  status: number,
  body: unknown,
): boolean {
  if (status >= 200 && status < 300) return true;
  if (status !== 409) return false;
  if (typeof body !== "object" || body === null) return false;
  const response = body as {
    alreadyInProgress?: unknown;
    data?: { jobId?: unknown };
    jobId?: unknown;
    success?: unknown;
  };
  return (
    response.success === true &&
    response.alreadyInProgress === true &&
    (typeof response.jobId === "string" ||
      typeof response.data?.jobId === "string")
  );
}

function isDirectCloudAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    ((err as { status?: unknown }).status === 401 ||
      (err as { status?: unknown }).status === 403)
  );
}

function directTopUpUrl(): string {
  return `${DEFAULT_DIRECT_CLOUD_BASE_URL}/dashboard/settings?tab=billing`;
}

function requireString(value: unknown, fieldName: string): string {
  const parsed = stringOrNull(value);
  if (!parsed) throw new Error(`Eliza Cloud response missing ${fieldName}`);
  return parsed;
}

function parseDirectCloudAgentCreateData(
  value: unknown,
  fallbackAgentName: string,
): DirectCloudAgentCreateData {
  const data = recordOrNull(value);
  if (!data) throw new Error("Eliza Cloud response missing data");
  return {
    // The cloud create response carries the new agent's id under `id` in most
    // branches but only `agentId` in the async-provisioning (202) branch.
    // Accept either — both are `agent.id` — so a provisioning agent (the common
    // new-user path) doesn't crash onboarding against an un-redeployed worker.
    id: requireString(data.id ?? data.agentId, "data.id"),
    agentName: stringOrNull(data.agentName) ?? fallbackAgentName,
    status: stringOrNull(data.status) ?? "pending",
  };
}

function toCloudCompatAgent(input: DirectCloudAgent): CloudCompatAgent {
  const id = stringOrNull(input.agentId) ?? requireString(input.id, "agent id");
  const agentName =
    stringOrNull(input.agentName) ?? stringOrNull(input.name) ?? id;
  const bridgeUrl = input.bridgeUrl ?? input.bridge_url ?? null;
  const webUiUrl = input.webUiUrl ?? input.web_ui_url ?? null;
  const runtimeUrl =
    input.apiBase ??
    input.api_base ??
    input.containerUrl ??
    input.container_url ??
    input.runtimeUrl ??
    input.runtime_url ??
    bridgeUrl ??
    "";
  const createdAt =
    stringOrNull(input.createdAt) ??
    stringOrNull(input.created_at) ??
    new Date(0).toISOString();
  const updatedAt =
    stringOrNull(input.updatedAt) ??
    stringOrNull(input.updated_at) ??
    createdAt;

  return {
    agent_id: id,
    agent_name: agentName,
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: bridgeUrl,
    web_ui_url: webUiUrl,
    status: stringOrNull(input.status) ?? "unknown",
    agent_config: input.agentConfig ?? input.agent_config ?? {},
    created_at: createdAt,
    updated_at: updatedAt,
    containerUrl: runtimeUrl,
    webUiUrl,
    database_status:
      stringOrNull(input.databaseStatus) ??
      stringOrNull(input.database_status) ??
      "unknown",
    error_message: input.errorMessage ?? input.error_message ?? null,
    last_heartbeat_at: input.lastHeartbeatAt ?? input.last_heartbeat_at ?? null,
  };
}

function normalizeCloudCompatProvisionResponse(
  input: CloudCompatAgentProvisionResponse,
  agentId: string,
): CloudCompatAgentProvisionResponse {
  const root = recordOrNull(input) ?? {};
  const rawData = recordOrNull(root.data) ?? {};
  const rawJob = recordOrNull(rawData.job) ?? recordOrNull(root.job) ?? {};
  const rawPolling = recordOrNull(root.polling) ?? {};

  const explicitJobId = firstString(
    rawData.jobId,
    rawData.job_id,
    rawJob.jobId,
    rawJob.job_id,
    rawJob.id,
    root.jobId,
    root.job_id,
  );
  const fallbackJobId = firstString(rawData.id, root.id);
  const jobId =
    explicitJobId ?? (fallbackJobId !== agentId ? fallbackJobId : null);
  const normalizedAgentId =
    firstString(
      rawData.agentId,
      rawData.agent_id,
      root.agentId,
      root.agent_id,
    ) ?? agentId;
  const status = firstString(
    rawData.status,
    rawData.state,
    rawData.phase,
    rawJob.status,
    rawJob.state,
    root.status,
    root.state,
    root.phase,
  );
  const bridgeUrl = firstString(
    rawData.bridgeUrl,
    rawData.bridge_url,
    rawData.runtimeUrl,
    rawData.runtime_url,
    root.bridgeUrl,
    root.bridge_url,
    root.runtimeUrl,
    root.runtime_url,
  );
  const webUiUrl = firstString(
    rawData.webUiUrl,
    rawData.web_ui_url,
    root.webUiUrl,
    root.web_ui_url,
  );
  const healthUrl = firstString(
    rawData.healthUrl,
    rawData.health_url,
    root.healthUrl,
    root.health_url,
  );
  const estimatedCompletionAt = firstString(
    rawData.estimatedCompletionAt,
    rawData.estimated_completion_at,
    root.estimatedCompletionAt,
    root.estimated_completion_at,
  );

  const normalizedData: NonNullable<CloudCompatAgentProvisionResponse["data"]> =
    {
      ...(rawData as NonNullable<CloudCompatAgentProvisionResponse["data"]>),
      agentId: normalizedAgentId,
    };
  if (jobId) normalizedData.jobId = jobId;
  if (status) normalizedData.status = status;
  if (bridgeUrl) normalizedData.bridgeUrl = bridgeUrl;
  if (webUiUrl) normalizedData.webUiUrl = webUiUrl;
  if (healthUrl) normalizedData.healthUrl = healthUrl;
  if (estimatedCompletionAt) {
    normalizedData.estimatedCompletionAt = estimatedCompletionAt;
  }

  const intervalMs = firstNumber(
    rawPolling.intervalMs,
    rawPolling.interval_ms,
    root.pollIntervalMs,
    root.poll_interval_ms,
  );
  const expectedDurationMs = firstNumber(
    rawPolling.expectedDurationMs,
    rawPolling.expected_duration_ms,
    root.expectedDurationMs,
    root.expected_duration_ms,
  );
  const endpoint = firstString(
    rawPolling.endpoint,
    root.pollingEndpoint,
    root.polling_endpoint,
  );
  const polling =
    endpoint || intervalMs !== null || expectedDurationMs !== null
      ? {
          ...(input.polling ?? {}),
          ...(endpoint ? { endpoint } : {}),
          ...(intervalMs !== null ? { intervalMs } : {}),
          ...(expectedDurationMs !== null ? { expectedDurationMs } : {}),
        }
      : input.polling;
  const explicitError = firstString(root.error, rawData.error);
  const success =
    typeof root.success === "boolean"
      ? root.success
      : !explicitError && Boolean(jobId || bridgeUrl || webUiUrl || status);

  return {
    ...input,
    success,
    ...(explicitError && !input.error ? { error: explicitError } : {}),
    data: normalizedData,
    ...(polling ? { polling } : {}),
  };
}

function normalizeCloudJobStatus(value: unknown): CloudCompatJob["status"] {
  switch (stringOrNull(value)?.toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
    case "done":
      return "completed";
    case "failed":
    case "failure":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    case "retrying":
    case "retry":
      return "retrying";
    case "in_progress":
    case "processing":
    case "provisioning":
    case "running":
    case "starting":
      return "processing";
    default:
      return "queued";
  }
}

function toCloudCompatJob(input: DirectCloudJob): CloudCompatJob {
  const data = recordOrNull(input.data) ?? {};
  const result = recordOrNull(input.result) ?? recordOrNull(data.result);
  const originalStatus = firstString(
    input.status,
    input.state,
    input.phase,
    data.status,
    data.state,
    data.phase,
  );
  const status = normalizeCloudJobStatus(originalStatus);
  const id = requireString(
    firstString(input.id, input.jobId, input.job_id, data.id),
    "job id",
  );
  const type = firstString(input.type, data.type) ?? "agent_provision";
  const createdAt =
    firstString(
      input.createdAt,
      input.created_at,
      data.createdAt,
      data.created_at,
    ) ?? new Date(0).toISOString();
  const startedAt =
    firstString(
      input.startedAt,
      input.started_at,
      data.startedAt,
      data.started_at,
    ) ?? null;
  const completedAt =
    firstString(
      input.completedAt,
      input.completed_at,
      data.completedAt,
      data.completed_at,
    ) ?? null;
  const retryCount =
    firstNumber(
      input.retryCount,
      input.retry_count,
      input.attempts,
      data.retryCount,
    ) ?? 0;
  const error =
    errorStringOrNull(input.error) ??
    errorStringOrNull(data.error) ??
    firstString(input.message, input.reason, data.message, data.reason);

  return {
    jobId: id,
    type,
    status,
    data,
    result: result ?? null,
    error,
    createdAt,
    startedAt,
    completedAt,
    retryCount,
    id,
    name: type,
    state: originalStatus ?? status,
    created_on: createdAt,
    completed_on: completedAt,
  };
}

// ---------------------------------------------------------------------------
// Declaration merging
// ---------------------------------------------------------------------------

declare module "./client-base" {
  interface ElizaClient {
    getCloudStatus(): Promise<CloudStatus>;
    getCloudCredits(): Promise<CloudCredits>;
    listCloudApiKeys(): Promise<CloudApiKeys>;
    getCloudBillingSummary(): Promise<CloudBillingSummary>;
    getCloudBillingSettings(): Promise<CloudBillingSettings>;
    updateCloudBillingSettings(
      request: CloudBillingSettingsUpdateRequest,
    ): Promise<CloudBillingSettings>;
    getCloudBillingPaymentMethods(): Promise<{
      success?: boolean;
      data?: CloudBillingPaymentMethod[];
      items?: CloudBillingPaymentMethod[];
      paymentMethods?: CloudBillingPaymentMethod[];
      [key: string]: unknown;
    }>;
    getCloudBillingHistory(): Promise<{
      success?: boolean;
      data?: CloudBillingHistoryItem[];
      items?: CloudBillingHistoryItem[];
      history?: CloudBillingHistoryItem[];
      [key: string]: unknown;
    }>;
    createCloudBillingCheckout(
      request: CloudBillingCheckoutRequest,
    ): Promise<CloudBillingCheckoutResponse>;
    createCloudBillingCryptoQuote(
      request: CloudBillingCryptoQuoteRequest,
    ): Promise<CloudBillingCryptoQuoteResponse>;
    cloudLogin(): Promise<CloudLoginResponse>;
    cloudLoginPoll(sessionId: string): Promise<CloudLoginPollResponse>;
    cloudLoginPersist(
      apiKey: string,
      identity?: { organizationId?: string; userId?: string },
    ): Promise<CloudLoginPersistResponse>;
    cloudDisconnect(): Promise<{ ok: boolean }>;
    getCloudCompatAgents(): Promise<{
      success: boolean;
      data: CloudCompatAgent[];
      error?: string;
    }>;
    createCloudCompatAgent(opts: {
      agentName: string;
      agentConfig?: Record<string, unknown>;
      environmentVars?: Record<string, string>;
      /**
       * Phase-0 tier flip. When true, omit `alwaysOn` so the backend derives a
       * SHARED (container-free, instant) agent instead of a DEDICATED always-on
       * one. Default (undefined/false) keeps the dedicated request unchanged.
       */
      preferSharedTier?: boolean;
      /**
       * Bypass the backend's org-scoped reuse guard so a SEPARATE agent is
       * minted even when the org already has a live one. The shared→dedicated
       * handoff sets this for the dedicated migration target; without it the
       * reuse guard hands back the shared bridge (dedicatedId === sharedId) and
       * the handoff probe never resolves. Default (undefined/false) leaves the
       * request byte-identical — every existing caller still reuses.
       */
      forceCreate?: boolean;
    }): Promise<{
      success: boolean;
      /**
       * Whether the backend actually MINTED a fresh agent (201/202) versus
       * handing back an existing non-terminal one via the idempotent reuse
       * guard (200, `created: false`), e.g. the org is at its per-org agent
       * cap (#11023). Callers surfacing a "created" affordance must not claim a
       * fresh agent when this is false (#14487). Undefined when the response
       * omits the flag (older worker / non-direct path); treat as unknown.
       */
      created?: boolean;
      data: {
        agentId: string;
        agentName: string;
        jobId: string;
        status: string;
        nodeId: string | null;
        message: string;
      };
    }>;
    ensureCloudCompatManagedDiscordAgent(): Promise<{
      success: boolean;
      data: {
        agent: CloudCompatAgent;
        created: boolean;
      };
    }>;
    provisionCloudCompatAgent(
      agentId: string,
    ): Promise<CloudCompatAgentProvisionResponse>;
    getCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgent;
    }>;
    getCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    createCloudCompatAgentManagedDiscordOauth(
      agentId: string,
      request?: {
        returnUrl?: string;
        botNickname?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
        applicationId: string | null;
      };
    }>;
    disconnectCloudCompatAgentManagedDiscord(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedDiscordStatus;
    }>;
    getCloudCompatAgentDiscordConfig(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    updateCloudCompatAgentDiscordConfig(
      agentId: string,
      config: CloudCompatDiscordConfig,
    ): Promise<{
      success: boolean;
      data: CloudCompatDiscordConfig;
    }>;
    getCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    createCloudCompatAgentManagedGithubOauth(
      agentId: string,
      request?: {
        scopes?: string[];
        postMessage?: boolean;
        returnUrl?: string;
      },
    ): Promise<{
      success: boolean;
      data: {
        authorizeUrl: string;
      };
    }>;
    linkCloudCompatAgentManagedGithub(
      agentId: string,
      connectionId: string,
    ): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    disconnectCloudCompatAgentManagedGithub(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatManagedGithubStatus;
    }>;
    listCloudOauthConnections(args?: {
      platform?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<{
      connections: CloudOAuthConnection[];
    }>;
    initiateCloudOauth(
      platform: string,
      request?: {
        redirectUrl?: string;
        scopes?: string[];
        connectionRole?: CloudOAuthConnectionRole;
      },
    ): Promise<CloudOAuthInitiateResponse>;
    initiateCloudTwitterOauth(request?: {
      redirectUrl?: string;
      connectionRole?: CloudOAuthConnectionRole;
    }): Promise<CloudTwitterOAuthInitiateResponse>;
    disconnectCloudOauthConnection(connectionId: string): Promise<{
      success?: boolean;
      error?: string;
      [key: string]: unknown;
    }>;
    getCloudCompatAgentGithubToken(agentId: string): Promise<{
      success: boolean;
      data: {
        accessToken: string;
        githubUsername: string;
      };
    }>;
    deleteCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      error?: string;
      data: { jobId: string; status: string; message: string };
    }>;
    /**
     * Edit a cloud agent in place — rename and/or update its config
     * (e.g. system prompt / bio). Backed by `PATCH /api/v1/eliza/agents/:id`.
     */
    updateCloudCompatAgent(
      agentId: string,
      edit: { agentName?: string; agentConfig?: Record<string, unknown> },
    ): Promise<{
      success: boolean;
      error?: string;
      data: { agentId: string; agentName: string };
    }>;
    getCloudCompatAgentStatus(agentId: string): Promise<{
      success: boolean;
      data: CloudCompatAgentStatus;
    }>;
    getCloudCompatAgentLogs(
      agentId: string,
      tail?: number,
    ): Promise<{ success: boolean; data: string }>;
    restartCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    suspendCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    resumeCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data: { jobId: string; status: string; message: string };
    }>;
    launchCloudCompatAgent(agentId: string): Promise<{
      success: boolean;
      data?: CloudCompatLaunchResult;
      error?: string;
    }>;
    getCloudCompatAvailability(): Promise<{
      success: boolean;
      data: {
        totalSlots: number;
        usedSlots: number;
        availableSlots: number;
        acceptingNewAgents: boolean;
      };
    }>;
    getCloudCompatJobStatus(jobId: string): Promise<{
      success: boolean;
      data: CloudCompatJob;
    }>;
    exportAgent(password: string, includeLogs?: boolean): Promise<Response>;
    getExportEstimate(): Promise<{
      estimatedBytes: number;
      memoriesCount: number;
      entitiesCount: number;
      roomsCount: number;
      worldsCount: number;
      tasksCount: number;
    }>;
    importAgent(
      password: string,
      fileBuffer: ArrayBuffer,
    ): Promise<{
      success: boolean;
      agentId: string;
      agentName: string;
      counts: Record<string, number>;
    }>;
    listLocalAgentBackups(): Promise<LocalAgentBackupMetadata[]>;
    createLocalAgentBackup(): Promise<LocalAgentBackupMetadata>;
    restoreLocalAgentBackup(fileName: string): Promise<{
      restored: true;
      requiresRestart: true;
    }>;
    getSandboxPlatform(): Promise<SandboxPlatformStatus>;
    getSandboxBrowser(): Promise<SandboxBrowserEndpoints>;
    getSandboxScreenshot(
      region?: SandboxScreenshotRegion,
    ): Promise<SandboxScreenshotPayload>;
    getSandboxWindows(): Promise<{
      windows: SandboxWindowInfo[];
      error?: string;
    }>;
    startDocker(): Promise<SandboxStartResponse>;
    cloudLoginDirect(cloudApiBase: string): Promise<{
      ok: boolean;
      apiBase?: string;
      browserUrl?: string;
      sessionId?: string;
      error?: string;
    }>;
    cloudLoginPollDirect(
      cloudApiBase: string,
      sessionId: string,
    ): Promise<{
      status: "pending" | "authenticated" | "expired" | "error";
      organizationId?: string;
      token?: string;
      userId?: string;
      error?: string;
    }>;
    provisionCloudSandbox(options: {
      cloudApiBase: string;
      authToken: string;
      name: string;
      bio?: string[];
      onProgress?: (status: string, detail?: string) => void;
      allowSharedRuntime?: boolean;
    }): Promise<{
      bridgeUrl: string;
      agentId: string;
      webUiUrl?: string | null;
      executionTier?: string;
    }>;
    /**
     * Reuse an existing cloud agent when one exists (so we don't mint a brand-new
     * agent on every sign-in), otherwise create + provision a fresh named one.
     * Always returns a valid per-agent REST adapter base (`.../agents/<id>`),
     * never the agent-id-less collection URL.
     */
    selectOrProvisionCloudAgent(options: {
      cloudApiBase: string;
      authToken: string;
      name: string;
      bio?: string[];
      /** Reuse this agent id when it still exists (e.g. a remembered choice). */
      preferAgentId?: string | null;
      /** Skip reuse and always create a new agent (explicit "Create new"). */
      forceCreate?: boolean;
      /**
       * Phase-0 tier flip. When true, a freshly created agent is requested as
       * SHARED (instant, container-free) instead of DEDICATED always-on. Only
       * affects the create branch; reuse of an existing agent is unaffected.
       */
      preferSharedTier?: boolean;
      /**
       * Authoritative list already fetched by the caller. First-run uses this
       * to avoid a second list/read race between "Finding your agents..." and
       * the bind decision.
       */
      knownAgents?: CloudCompatAgent[];
      /**
       * Return the Cloud REST adapter base (`/api/v1/eliza/agents/:id`) even
       * when the agent also exposes a dedicated subdomain. First-run uses this
       * for the default Steward-token flow; explicit dedicated handoff paths
       * leave it off so they can still run the `/pair` exchange.
       */
      preferStewardAgentAdapter?: boolean;
      onProgress?: (status: string, detail?: string) => void;
      /**
       * Cold-boot wait tuning for a reused dedicated agent that is not yet
       * `running` (a dedicated container cold-starts in ~5 minutes — #8621).
       * Defaults: poll every 5 s, give up after 6 minutes. Exposed so tests
       * can drive the wait loop against a mock cloud without real minutes.
       */
      wakePollIntervalMs?: number;
      wakeTimeoutMs?: number;
    }): Promise<{
      agentId: string;
      agentName: string;
      apiBase: string;
      bridgeUrl: string | null;
      created: boolean;
      /**
       * Dedicated agent subdomains require the official cloud pairing-token
       * handoff before the browser can use `/api/*` with an agent-local bearer.
       * Shared-runtime adapters continue to use the Steward session token.
       */
      requiresAgentPairing?: boolean;
    }>;
    /**
     * Background shared→personal handoff for a freshly provisioned cloud agent:
     * once the dedicated container is reachable, copy the conversation the user
     * built on the shared adapter into it and switch the live client over.
     * Best-effort and non-blocking — failure leaves the user on the (working)
     * shared adapter.
     */
    startCloudAgentHandoff(options: {
      agentId: string;
      sharedApiBase: string;
      conversationId: string;
      cloudApiBase: string;
      authToken: string;
      /**
       * The SEPARATE dedicated agent to migrate onto. When set, the readiness
       * probe polls THIS agent's record for its container base (the shared
       * `agentId` is container-free and never exposes one). Omitted → the probe
       * polls `agentId` itself, the pre-shared-tier behavior.
       */
      dedicatedAgentId?: string;
      onSwitch: (containerBase: string) => void | Promise<void>;
      intervalMs?: number;
      timeoutMs?: number;
      log?: (message: string) => void;
    }): Promise<
      import("../cloud/handoff/conversation-handoff").ConversationHandoffResult
    >;
    /**
     * Delete the transient SHARED bridge agent (+ its `shared_runtime_history`,
     * cascaded server-side) once the user has been switched to their dedicated
     * agent (PR4). MUST only be called after a confirmed-successful handoff —
     * deleting the shared while the user is still served by it loses their
     * conversation.
     *
     * Pins the request to the explicit `cloudApiBase` (NOT the client's mutable
     * `baseUrl`): by the time the switch succeeds the client has already
     * repointed onto the dedicated container, so the base-derived
     * `deleteCloudCompatAgent` would no longer resolve the cloud API. Shared
     * delete is synchronous server-side (no container teardown), so success
     * means the row + history are gone.
     */
    deleteSharedBridgeAgent(
      agentId: string,
      options: { cloudApiBase: string; authToken: string },
    ): Promise<{ success: boolean; error?: string }>;
    checkBugReportInfo(): Promise<{
      nodeVersion?: string;
      platform?: string;
      submissionMode?: "remote" | "github" | "fallback";
    }>;
    submitBugReport(report: {
      description: string;
      stepsToReproduce: string;
      expectedBehavior?: string;
      actualBehavior?: string;
      environment?: string;
      nodeVersion?: string;
      modelProvider?: string;
      logs?: string;
      category?: "general" | "startup-failure";
      appVersion?: string;
      releaseChannel?: string;
      startup?: {
        reason?: string;
        phase?: string;
        message?: string;
        detail?: string;
        status?: number;
        path?: string;
      };
    }): Promise<{
      accepted?: boolean;
      id?: string;
      url?: string;
      fallback?: string;
      destination?: "remote" | "github" | "fallback";
    }>;
  }
}

// ---------------------------------------------------------------------------
// Prototype augmentation
// ---------------------------------------------------------------------------

ElizaClient.prototype.getCloudStatus = async function (this: ElizaClient) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase) {
    if (!readDirectCloudToken(this)) {
      return {
        connected: false,
        enabled: true,
        hasApiKey: false,
        reason: "not-authenticated",
        topUpUrl: directTopUpUrl(),
      };
    }
    try {
      const user = await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/user",
      );
      const data =
        user && typeof user.data === "object" && user.data !== null
          ? (user.data as Record<string, unknown>)
          : user;
      return {
        connected: true,
        enabled: true,
        hasApiKey: true,
        cloudVoiceProxyAvailable: true,
        userId: typeof data?.id === "string" ? data.id : undefined,
        organizationId:
          typeof data?.organization_id === "string"
            ? data.organization_id
            : undefined,
        topUpUrl: directTopUpUrl(),
      };
    } catch (err) {
      if (isDirectCloudAuthError(err)) {
        return {
          connected: false,
          enabled: true,
          hasApiKey: true,
          reason: "auth-rejected",
          topUpUrl: directTopUpUrl(),
        };
      }
      throw err;
    }
  }
  return this.fetch("/api/cloud/status");
};

ElizaClient.prototype.getCloudCredits = async function (this: ElizaClient) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase) {
    if (!readDirectCloudToken(this)) {
      return {
        connected: false,
        balance: null,
        error: "Not connected to Eliza Cloud.",
        topUpUrl: directTopUpUrl(),
      };
    }
    try {
      const data = await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/credits/balance",
      );
      const balance = numberOrNull(data?.balance);
      return {
        connected: true,
        balance: Number.isFinite(balance) ? balance : null,
        low: typeof balance === "number" ? balance < 2 : undefined,
        critical: typeof balance === "number" ? balance < 0.5 : undefined,
        topUpUrl: directTopUpUrl(),
      };
    } catch (err) {
      if (isDirectCloudAuthError(err)) {
        return {
          connected: false,
          balance: null,
          authRejected: true,
          error: "Eliza Cloud rejected the saved API key.",
          topUpUrl: directTopUpUrl(),
        };
      }
      throw err;
    }
  }
  return this.fetch("/api/cloud/credits");
};

// API-key inventory for the in-app Cloud view (keys count + manage link).
// Direct-cloud only: `GET /api/v1/api-keys` is session-gated upstream
// (requireUserWithOrg) and has no /api/cloud/* agent-host proxy, so when the
// client has no direct cloud base — or the credential is an API key rather
// than a steward session — the result degrades to `keys: null` with a reason
// instead of throwing or fabricating an empty list.
ElizaClient.prototype.listCloudApiKeys = async function (this: ElizaClient) {
  const manageUrl = `${DEFAULT_DIRECT_CLOUD_BASE_URL}/dashboard/api-keys`;
  const directBase = resolveDirectCloudClientApiBase(this);
  if (!directBase || !readDirectCloudToken(this)) {
    return { keys: null, manageUrl, reason: "not-connected" as const };
  }
  try {
    const data = await directCloudRequest<Record<string, unknown>>(
      this,
      "/api/v1/api-keys",
    );
    const rawKeys = Array.isArray(data?.keys) ? data.keys : [];
    const keys: CloudApiKeySummary[] = rawKeys.flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const record = raw as Record<string, unknown>;
      const id = stringOrNull(record.id);
      const name = stringOrNull(record.name);
      if (!id || !name) return [];
      return [
        {
          id,
          name,
          keyPrefix: stringOrNull(record.key_prefix),
          createdAt: stringOrNull(record.created_at),
        },
      ];
    });
    return { keys, manageUrl };
  } catch (err) {
    if (isDirectCloudAuthError(err)) {
      return { keys: null, manageUrl, reason: "session-required" as const };
    }
    throw err;
  }
};

ElizaClient.prototype.getCloudBillingSummary = async function (
  this: ElizaClient,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return {
      balance: null,
      currency: "USD",
      topUpUrl: directTopUpUrl(),
      embeddedCheckoutEnabled: false,
      hostedCheckoutEnabled: true,
      cryptoEnabled: false,
    };
  }
  const direct = directBase
    ? await directCloudRequest<Record<string, unknown>>(
        this,
        "/api/v1/credits/summary",
      )
    : null;
  if (direct) {
    const organization =
      typeof direct.organization === "object" && direct.organization !== null
        ? (direct.organization as Record<string, unknown>)
        : {};
    const pricing =
      typeof direct.pricing === "object" && direct.pricing !== null
        ? (direct.pricing as Record<string, unknown>)
        : {};
    const balance = numberOrNull(organization.creditBalance);
    return {
      ...direct,
      balance: Number.isFinite(balance) ? balance : null,
      currency: "USD",
      topUpUrl: directTopUpUrl(),
      embeddedCheckoutEnabled: false,
      hostedCheckoutEnabled: true,
      cryptoEnabled:
        typeof pricing.x402Enabled === "boolean" ? pricing.x402Enabled : false,
      low: typeof balance === "number" ? balance < 2 : undefined,
      critical: typeof balance === "number" ? balance < 0.5 : undefined,
    };
  }
  return this.fetch("/api/cloud/billing/summary");
};

ElizaClient.prototype.getCloudBillingSettings = async function (
  this: ElizaClient,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return { success: false, error: "Not connected to Eliza Cloud." };
  }
  const direct = directBase
    ? await directCloudRequest<CloudBillingSettings>(
        this,
        "/api/v1/billing/settings",
      )
    : null;
  if (direct) return direct;
  return this.fetch("/api/cloud/billing/settings");
};

ElizaClient.prototype.updateCloudBillingSettings = async function (
  this: ElizaClient,
  request,
) {
  const directBase = resolveDirectCloudClientApiBase(this);
  if (directBase && !readDirectCloudToken(this)) {
    return { success: false, error: "Not connected to Eliza Cloud." };
  }
  const direct = directBase
    ? await directCloudRequest<CloudBillingSettings>(
        this,
        "/api/v1/billing/settings",
        {
          method: "PUT",
          body: JSON.stringify(request),
        },
      )
    : null;
  if (direct) return direct;
  return this.fetch("/api/cloud/billing/settings", {
    method: "PUT",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.getCloudBillingPaymentMethods = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/payment-methods");
};

ElizaClient.prototype.getCloudBillingHistory = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/history");
};

ElizaClient.prototype.createCloudBillingCheckout = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/billing/checkout", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.createCloudBillingCryptoQuote = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/billing/crypto/quote", {
    method: "POST",
    body: JSON.stringify(request),
  });
};

ElizaClient.prototype.cloudLogin = async function (this: ElizaClient) {
  return this.fetch("/api/cloud/login", { method: "POST" });
};

ElizaClient.prototype.cloudLoginPoll = async function (
  this: ElizaClient,
  sessionId,
) {
  return this.fetch(
    `/api/cloud/login/status?sessionId=${encodeURIComponent(sessionId)}`,
  );
};

ElizaClient.prototype.cloudLoginPersist = async function (
  this: ElizaClient,
  apiKey,
  identity,
) {
  return this.fetch("/api/cloud/login/persist", {
    method: "POST",
    body: JSON.stringify({
      apiKey,
      ...(identity?.organizationId
        ? { organizationId: identity.organizationId }
        : {}),
      ...(identity?.userId ? { userId: identity.userId } : {}),
    }),
  });
};

ElizaClient.prototype.cloudDisconnect = async function (this: ElizaClient) {
  return this.fetch("/api/cloud/disconnect", { method: "POST" });
};

ElizaClient.prototype.getCloudCompatAgents = async function (
  this: ElizaClient,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent[];
    error?: string;
  }>(this, "/api/v1/eliza/agents");
  if (direct) {
    return {
      success: direct.success,
      data: (direct.data ?? []).map(toCloudCompatAgent),
    };
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: [],
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudAgent[];
      error?: string;
    }>("/api/v1/eliza/agents");
    return {
      success: response.success,
      data: (response.data ?? []).map(toCloudCompatAgent),
    };
  }

  return this.fetch("/api/cloud/compat/agents");
};

ElizaClient.prototype.createCloudCompatAgent = async function (
  this: ElizaClient,
  opts,
) {
  // Phase-0 tier flip. The backend derives `execution_tier` from the request:
  // `alwaysOn: true` → DEDICATED always-on container; omitting it (for a plain
  // chat agent) → SHARED, container-free, instant. Default is dedicated — only
  // the demo flag drops `alwaysOn` to request shared. `tierFields` is spread
  // into both create bodies so the dedicated path stays byte-identical to before.
  const tierFields = opts.preferSharedTier ? {} : { alwaysOn: true };
  const direct = await directCloudRequest<{
    success: boolean;
    // `created: false` means the backend reused an existing non-terminal agent
    // (idempotent 200) instead of minting a fresh one, e.g. the org hit its
    // per-org cap (#11023). Thread it up so the UI can tell the truth (#14487).
    created?: boolean;
    data: unknown;
    error?: string;
  }>(this, "/api/v1/eliza/agents", {
    method: "POST",
    body: JSON.stringify({
      agentName: opts.agentName,
      // The Eliza app provisions a DEDICATED (own-container, always-on) agent —
      // the full experience, and the paid tier. New users have the signup credit
      // grant so they get a real agent; out-of-credit users get the cloud's
      // 402 add-credits prompt (the monetization path) rather than a shared agent.
      // (With the Phase-0 shared-tier flag on, `alwaysOn` is dropped so the
      // backend derives a SHARED agent instead — see tierFields above.)
      ...tierFields,
      // Opt out of the backend reuse guard so a SEPARATE agent is minted (the
      // shared→dedicated handoff target). Omitted by default → reuse unchanged.
      ...(opts.forceCreate ? { forceCreate: true } : {}),
      ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
      ...(opts.environmentVars
        ? { environmentVars: opts.environmentVars }
        : {}),
    }),
  });
  if (direct) {
    const data = parseDirectCloudAgentCreateData(direct.data, opts.agentName);
    return {
      success: direct.success,
      created: direct.created,
      data: {
        agentId: data.id,
        agentName: data.agentName,
        jobId: "",
        status: data.status,
        nodeId: null,
        message: direct.success ? "Agent created" : (direct.error ?? ""),
      },
    };
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: {
        agentId: "",
        agentName: opts.agentName,
        jobId: "",
        status: "error",
        nodeId: null,
        message: nativeDirectCloudAuthMissingMessage(),
      },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      // See the direct-path note: `created: false` = idempotent reuse (#14487).
      created?: boolean;
      data: unknown;
      error?: string;
    }>("/api/v1/eliza/agents", {
      method: "POST",
      body: JSON.stringify({
        agentName: opts.agentName,
        // Dedicated (own-container, always-on) agent — see the direct-path note.
        // The Phase-0 shared-tier flag drops `alwaysOn` here too (tierFields).
        ...tierFields,
        // Opt out of the backend reuse guard so a SEPARATE agent is minted (the
        // shared→dedicated handoff target). Omitted by default → reuse unchanged.
        ...(opts.forceCreate ? { forceCreate: true } : {}),
        ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
        ...(opts.environmentVars
          ? { environmentVars: opts.environmentVars }
          : {}),
      }),
    });
    const data = parseDirectCloudAgentCreateData(response.data, opts.agentName);
    return {
      success: response.success,
      created: response.created,
      data: {
        agentId: data.id,
        agentName: data.agentName,
        jobId: "",
        status: data.status,
        nodeId: null,
        message: response.success ? "Agent created" : (response.error ?? ""),
      },
    };
  }

  return this.fetch("/api/cloud/compat/agents", {
    method: "POST",
    body: JSON.stringify(opts),
  });
};

ElizaClient.prototype.ensureCloudCompatManagedDiscordAgent = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/v1/app/discord/gateway-agent", {
    method: "POST",
  });
};

ElizaClient.prototype.provisionCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<CloudCompatAgentProvisionResponse>(
    this,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
  );
  if (direct) {
    return normalizeCloudCompatProvisionResponse(direct, agentId);
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: nativeDirectCloudAuthMissingMessage(),
      data: { agentId, status: "auth-missing" },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<CloudCompatAgentProvisionResponse>(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
      { method: "POST" },
      { allowNonOk: true },
    );
    return normalizeCloudCompatProvisionResponse(response, agentId);
  }

  // Proxy fallback (only hit when direct cloud token is not available — see
  // `directCloudRequest` token plumbing). The upstream provision route lives
  // under `/api/v1/eliza/agents/{id}/provision` (see
  // cloud/apps/api/v1/eliza/agents/[agentId]/provision/route.ts). The
  // earlier proxy path `/api/cloud/v1/app/agents/{id}/provision` returned
  // 405 because cloud has no provision sub-route under `/v1/app/agents`.
  const response = await this.fetch<CloudCompatAgentProvisionResponse>(
    `/api/cloud/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
    { allowNonOk: true },
  );
  return normalizeCloudCompatProvisionResponse(response, agentId);
};

ElizaClient.prototype.getCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent;
    error?: string;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
  if (direct) {
    return {
      success: direct.success,
      data: toCloudCompatAgent(direct.data ?? { id: agentId }),
    };
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: toCloudCompatAgent({ id: agentId, status: "auth-missing" }),
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudAgent;
      error?: string;
    }>(`/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
    return {
      success: response.success,
      data: toCloudCompatAgent(response.data ?? { id: agentId }),
    };
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`);
};

ElizaClient.prototype.getCloudCompatAgentManagedDiscord = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`,
  );
};

ElizaClient.prototype.createCloudCompatAgentManagedDiscordOauth =
  async function (this: ElizaClient, agentId, request = {}) {
    return this.fetch(
      `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/oauth`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  };

ElizaClient.prototype.disconnectCloudCompatAgentManagedDiscord =
  async function (this: ElizaClient, agentId) {
    return this.fetch(
      `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord`,
      {
        method: "DELETE",
      },
    );
  };

ElizaClient.prototype.getCloudCompatAgentDiscordConfig = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`,
  );
};

ElizaClient.prototype.updateCloudCompatAgentDiscordConfig = async function (
  this: ElizaClient,
  agentId,
  config,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/discord/config`,
    {
      method: "PATCH",
      body: JSON.stringify(config),
    },
  );
};

ElizaClient.prototype.getCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`,
  );
};

ElizaClient.prototype.createCloudCompatAgentManagedGithubOauth =
  async function (this: ElizaClient, agentId, request = {}) {
    try {
      return await this.fetch(
        `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/oauth`,
        {
          method: "POST",
          body: JSON.stringify(request),
        },
      );
    } catch (error) {
      if (!isCloudRouteNotFound(error)) {
        throw error;
      }

      const params = new URLSearchParams({
        target: "agent",
        agent_id: agentId,
      });
      if (request.postMessage) {
        params.set("post_message", "1");
      }
      if (request.returnUrl) {
        params.set("return_url", request.returnUrl);
      }

      const fallback = await this.initiateCloudOauth("github", {
        redirectUrl: `/api/v1/eliza/lifeops/github-complete?${params.toString()}`,
        connectionRole: "agent",
        scopes: request.scopes,
      });

      return {
        success: true,
        data: {
          authorizeUrl: fallback.authUrl,
        },
      };
    }
  };

ElizaClient.prototype.linkCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
  connectionId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/link`,
    {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    },
  );
};

ElizaClient.prototype.disconnectCloudCompatAgentManagedGithub = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github`,
    {
      method: "DELETE",
    },
  );
};

ElizaClient.prototype.listCloudOauthConnections = async function (
  this: ElizaClient,
  args,
) {
  const params = new URLSearchParams();
  if (args?.platform) {
    params.set("platform", args.platform);
  }
  if (args?.connectionRole) {
    params.set("connectionRole", args.connectionRole);
  }
  const query = params.toString();
  return this.fetch(
    `/api/cloud/v1/oauth/connections${query ? `?${query}` : ""}`,
  );
};

ElizaClient.prototype.initiateCloudOauth = async function (
  this: ElizaClient,
  platform,
  request,
) {
  try {
    return await this.fetch(
      `/api/cloud/v1/oauth/${encodeURIComponent(platform)}/initiate`,
      {
        method: "POST",
        body: JSON.stringify(request ?? {}),
      },
    );
  } catch (error) {
    if (!isCloudRouteNotFound(error)) {
      throw error;
    }

    return this.fetch(
      `/api/cloud/v1/oauth/initiate?provider=${encodeURIComponent(platform)}`,
      {
        method: "POST",
        body: JSON.stringify(request ?? {}),
      },
    );
  }
};

ElizaClient.prototype.initiateCloudTwitterOauth = async function (
  this: ElizaClient,
  request,
) {
  return this.fetch("/api/cloud/v1/twitter/connect", {
    method: "POST",
    body: JSON.stringify(request ?? {}),
  });
};

ElizaClient.prototype.disconnectCloudOauthConnection = async function (
  this: ElizaClient,
  connectionId,
) {
  return this.fetch(
    `/api/cloud/v1/oauth/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "DELETE",
    },
  );
};

ElizaClient.prototype.getCloudCompatAgentGithubToken = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/github/token`,
  );
};

ElizaClient.prototype.deleteCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const normalizeDelete = (response: {
    success?: boolean;
    data?: { message?: string; status?: string; jobId?: string };
    error?: string;
  }) => ({
    success: response.success === true,
    ...(response.error ? { error: response.error } : {}),
    data: {
      // A 202 async delete carries a jobId the caller can poll
      // (`/api/v1/jobs/<id>`) to learn whether the teardown actually
      // completed. A synchronous delete returns no jobId.
      jobId: response.data?.jobId ?? "",
      status:
        response.data?.status ??
        (response.success === true ? "deleted" : "error"),
      message:
        response.data?.message ??
        (response.success === true
          ? "Agent delete complete"
          : (response.error ?? "Agent delete failed")),
    },
  });

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { message?: string; status?: string; jobId?: string };
    error?: string;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
  if (direct) return normalizeDelete(direct);

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: nativeDirectCloudAuthMissingMessage(),
      data: {
        jobId: "",
        status: "auth-missing",
        message: nativeDirectCloudAuthMissingMessage(),
      },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: { message?: string; status?: string; jobId?: string };
      error?: string;
    }>(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
      { allowNonOk: true },
    );
    return normalizeDelete(response);
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.updateCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
  edit,
) {
  const path = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
  const body = JSON.stringify({
    ...(edit.agentName !== undefined ? { agentName: edit.agentName } : {}),
    ...(edit.agentConfig !== undefined
      ? { agentConfig: edit.agentConfig }
      : {}),
  });
  const normalize = (response: {
    success?: boolean;
    data?: { agentId?: string; agentName?: string };
    error?: string;
  }) => ({
    success: response.success === true,
    ...(response.error ? { error: response.error } : {}),
    data: {
      agentId: response.data?.agentId ?? agentId,
      agentName: response.data?.agentName ?? edit.agentName ?? "",
    },
  });

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { agentId?: string; agentName?: string };
    error?: string;
  }>(this, path, { method: "PATCH", body });
  if (direct) return normalize(direct);

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: nativeDirectCloudAuthMissingMessage(),
      data: { agentId, agentName: edit.agentName ?? "" },
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: { agentId?: string; agentName?: string };
      error?: string;
    }>(path, { method: "PATCH", body }, { allowNonOk: true });
    return normalize(response);
  }

  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body,
  });
};

ElizaClient.prototype.getCloudCompatAgentStatus = async function (
  this: ElizaClient,
  agentId,
) {
  // Direct-cloud fallback for mobile/web clients that have no local
  // Eliza API server proxying `/api/cloud/compat/agents/...`. The
  // direct cloud surface returns a richer agent record at
  // `/api/v1/eliza/agents/<id>`; we project it down to the
  // `CloudCompatAgentStatus` shape callers expect.
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudAgent;
  }>(this, `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`);
  if (direct) {
    const a = toCloudCompatAgent(direct.data ?? { id: agentId });
    return {
      success: direct.success,
      data: {
        status: a.status,
        lastHeartbeat: a.last_heartbeat_at,
        bridgeUrl: a.bridge_url,
        webUiUrl: a.webUiUrl,
        currentNode: null,
        suspendedReason: null,
        databaseStatus: a.database_status,
      },
    };
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: {
        status: "auth-missing",
        lastHeartbeat: null,
        bridgeUrl: null,
        webUiUrl: null,
        currentNode: null,
        suspendedReason: nativeDirectCloudAuthMissingMessage(),
        databaseStatus: "unknown",
      },
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/status`,
  );
};

ElizaClient.prototype.getCloudCompatAgentLogs = async function (
  this: ElizaClient,
  agentId,
  tail = 100,
) {
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/logs?tail=${tail}`,
  );
};

/**
 * Normalize a cloud lifecycle (suspend/resume) response into the
 * `{ success, data: { jobId, status, message } }` shape the UI expects. The
 * direct cloud routes return a 202 `{ success, data: { jobId, status,
 * message } }` async-job envelope; the legacy proxy returns the same shape.
 * A few routes carry the human message at the envelope top level, so read both.
 */
function normalizeCloudLifecycleResponse(
  response: {
    success?: boolean;
    data?: { jobId?: string; status?: string; message?: string };
    message?: string;
    error?: string;
  },
  fallbackVerb: string,
): { success: boolean; error?: string; data: LifecycleResult } {
  const success = response.success === true;
  return {
    success,
    ...(response.error ? { error: response.error } : {}),
    data: {
      jobId: response.data?.jobId ?? "",
      status: response.data?.status ?? (success ? "queued" : "error"),
      message:
        response.data?.message ??
        response.message ??
        (success
          ? `Agent ${fallbackVerb} enqueued`
          : (response.error ?? `Agent ${fallbackVerb} failed`)),
    },
  };
}

/**
 * Drive a cloud agent lifecycle action (suspend/resume) through the
 * direct-cloud ladder — direct token request → native-auth-missing guard →
 * direct-cloud-base same-origin fetch → legacy `/api/cloud/compat` proxy.
 * Mirrors `deleteCloudCompatAgent` so the Power/Start buttons work on
 * phone/web (which have no local API server proxying `/api/cloud/compat/...`).
 *
 * Only suspend/resume go through this ladder: the cloud-api exposes
 * `/api/v1/eliza/agents/:id/{suspend,resume}` (also sleep/wake) but NOT a
 * `restart` route, so restart stays on its legacy `/api/cloud/compat` proxy
 * (see `restartCloudCompatAgent`).
 */
async function runCloudLifecycleAction(
  client: ElizaClient,
  agentId: string,
  action: "suspend" | "resume",
): Promise<{ success: boolean; error?: string; data: LifecycleResult }> {
  const encoded = encodeURIComponent(agentId);
  const directPath = `/api/v1/eliza/agents/${encoded}/${action}`;

  const direct = await directCloudRequest<{
    success: boolean;
    data?: { jobId?: string; status?: string; message?: string };
    error?: string;
  }>(client, directPath, { method: "POST" });
  if (direct) return normalizeCloudLifecycleResponse(direct, action);

  if (isNativeDirectCloudAuthMissing(client)) {
    return {
      success: false,
      error: nativeDirectCloudAuthMissingMessage(),
      data: {
        jobId: "",
        status: "auth-missing",
        message: nativeDirectCloudAuthMissingMessage(),
      },
    };
  }

  if (isDirectCloudBase(client)) {
    const response = await client.fetch<{
      success: boolean;
      data?: { jobId?: string; status?: string; message?: string };
      error?: string;
    }>(directPath, { method: "POST" }, { allowNonOk: true });
    return normalizeCloudLifecycleResponse(response, action);
  }

  return client.fetch(
    `/api/cloud/compat/agents/${encoded}/${action}`,
    { method: "POST" },
    { allowNonOk: true },
  );
}

ElizaClient.prototype.restartCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  // Restart has no `/api/v1/eliza/agents/:id/restart` route (unlike
  // suspend/resume), so it stays on the legacy compat proxy rather than the
  // direct-cloud ladder, preserving its prior behavior.
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/restart`,
    { method: "POST" },
  );
};

ElizaClient.prototype.suspendCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return runCloudLifecycleAction(this, agentId, "suspend");
};

ElizaClient.prototype.resumeCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return runCloudLifecycleAction(this, agentId, "resume");
};

ElizaClient.prototype.launchCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: CloudCompatLaunchResult;
    error?: string;
  }>(this, `/api/compat/agents/${encodeURIComponent(agentId)}/launch`, {
    method: "POST",
  });
  if (direct) return direct;

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    return this.fetch(
      `/api/compat/agents/${encodeURIComponent(agentId)}/launch`,
      { method: "POST" },
      { allowNonOk: true },
    );
  }

  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/launch`,
    { method: "POST" },
    { allowNonOk: true },
  );
};

ElizaClient.prototype.getCloudCompatAvailability = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/compat/availability");
};

ElizaClient.prototype.getCloudCompatJobStatus = async function (
  this: ElizaClient,
  jobId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: DirectCloudJob;
    error?: string;
  }>(this, `/api/v1/jobs/${encodeURIComponent(jobId)}`);
  if (direct) {
    return {
      success: direct.success,
      data: toCloudCompatJob(direct.data ?? { id: jobId }),
    };
  }

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: toCloudCompatJob({
        id: jobId,
        status: "failed",
        error: nativeDirectCloudAuthMissingMessage(),
      }),
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    const response = await this.fetch<{
      success: boolean;
      data?: DirectCloudJob;
      error?: string;
    }>(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
    return {
      success: response.success,
      data: toCloudCompatJob(response.data ?? { id: jobId }),
    };
  }

  return this.fetch(`/api/cloud/compat/jobs/${encodeURIComponent(jobId)}`);
};

ElizaClient.prototype.exportAgent = async function (
  this: ElizaClient,
  password,
  includeLogs = false,
) {
  if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return this.rawRequest("/api/agent/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password, includeLogs }),
  });
};

ElizaClient.prototype.getExportEstimate = async function (this: ElizaClient) {
  return this.fetch("/api/agent/export/estimate");
};

ElizaClient.prototype.importAgent = async function (
  this: ElizaClient,
  password,
  fileBuffer,
) {
  if (password.length < AGENT_TRANSFER_MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${AGENT_TRANSFER_MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  const passwordBytes = new TextEncoder().encode(password);
  const envelope = new Uint8Array(
    4 + passwordBytes.length + fileBuffer.byteLength,
  );
  const view = new DataView(envelope.buffer);
  view.setUint32(0, passwordBytes.length, false);
  envelope.set(passwordBytes, 4);
  envelope.set(new Uint8Array(fileBuffer), 4 + passwordBytes.length);

  const res = await this.rawRequest("/api/agent/import", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: envelope,
  });

  const data = (await res.json()) as {
    error?: string;
    success?: boolean;
    agentId?: string;
    agentName?: string;
    counts?: Record<string, number>;
  };
  if (!data.success) {
    throw new Error(data.error ?? `Import failed (${res.status})`);
  }
  return data as {
    success: boolean;
    agentId: string;
    agentName: string;
    counts: Record<string, number>;
  };
};

ElizaClient.prototype.listLocalAgentBackups = async function (
  this: ElizaClient,
) {
  const response = await this.fetch<{ backups: LocalAgentBackupMetadata[] }>(
    "/api/backups",
  );
  return response.backups;
};

ElizaClient.prototype.createLocalAgentBackup = async function (
  this: ElizaClient,
) {
  const response = await this.fetch<{ backup: LocalAgentBackupMetadata }>(
    "/api/backups",
    {
      method: "POST",
    },
  );
  return response.backup;
};

ElizaClient.prototype.restoreLocalAgentBackup = async function (
  this: ElizaClient,
  fileName,
) {
  return this.fetch<{ restored: true; requiresRestart: true }>(
    "/api/backups/restore",
    {
      method: "POST",
      body: JSON.stringify({ fileName }),
    },
  );
};

ElizaClient.prototype.getSandboxPlatform = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/platform");
};

ElizaClient.prototype.getSandboxBrowser = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/browser");
};

ElizaClient.prototype.getSandboxScreenshot = async function (
  this: ElizaClient,
  region?,
) {
  if (!region) {
    return this.fetch("/api/sandbox/screen/screenshot", {
      method: "POST",
    });
  }
  return this.fetch("/api/sandbox/screen/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(region),
  });
};

ElizaClient.prototype.getSandboxWindows = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/screen/windows");
};

ElizaClient.prototype.startDocker = async function (this: ElizaClient) {
  return this.fetch("/api/sandbox/docker/start", { method: "POST" });
};

ElizaClient.prototype.cloudLoginDirect = async function (
  this: ElizaClient,
  cloudApiBase,
) {
  const sessionId = generateCloudLoginSessionId();
  const cloudWebBase = resolveDirectCloudWebBase(cloudApiBase);
  const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  try {
    if (shouldUseNativeCloudHttp()) {
      const res = await CapacitorHttp.post({
        url: `${authApiBase}/api/auth/cli-session`,
        headers: { "Content-Type": "application/json" },
        data: { sessionId },
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      });
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `Login failed (${res.status})` };
      }
      return {
        ok: true,
        apiBase: authApiBase,
        sessionId,
        browserUrl: buildCloudCliLoginBrowserUrl(cloudWebBase, sessionId),
      };
    }

    const res = await fetch(
      resolveBrowserCloudApiRequestUrl(`${authApiBase}/api/auth/cli-session`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      },
    );
    if (!res.ok) {
      return { ok: false, error: `Login failed (${res.status})` };
    }
    return {
      ok: true,
      apiBase: authApiBase,
      sessionId,
      browserUrl: buildCloudCliLoginBrowserUrl(cloudWebBase, sessionId),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reach Eliza Cloud: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

ElizaClient.prototype.cloudLoginPollDirect = async function (
  this: ElizaClient,
  cloudApiBase,
  sessionId,
) {
  const authApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  try {
    if (shouldUseNativeCloudHttp()) {
      const res = await CapacitorHttp.get({
        url: `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        responseType: "json",
        connectTimeout: 10_000,
        readTimeout: 10_000,
      });
      if (res.status < 200 || res.status >= 300) {
        if (res.status === 404) {
          return {
            status: "expired" as const,
            error: "Auth session expired or not found",
          };
        }
        return {
          status: "error" as const,
          error: `Poll failed (${res.status})`,
        };
      }
      return parseCloudLoginPollData(parseDirectCloudJsonSafe(res.data));
    }

    const res = await fetch(
      resolveBrowserCloudApiRequestUrl(
        `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
      ),
    );
    if (!res.ok) {
      if (res.status === 404) {
        return {
          status: "expired" as const,
          error: "Auth session expired or not found",
        };
      }
      return {
        status: "error" as const,
        error: `Poll failed (${res.status})`,
      };
    }
    return parseCloudLoginPollData(await res.json());
  } catch {
    return { status: "error" as const, error: "Poll request failed" };
  }
};

/**
 * Resolve the reachable API base for a freshly provisioned cloud agent.
 *
 * Prefer a reachable URL the server explicitly provides (`webUiUrl`); otherwise
 * fall back to the raw container `bridgeUrl`.
 *
 * For a DEDICATED agent the server-provided `webUiUrl` IS the unified-auth
 * proxy base (`https://<agentId>.elizacloud.ai`, live since 2026-06-19 —
 * #8621/#8628): the Worker validates the caller's cloud token, swaps in the
 * container's own `ELIZA_API_TOKEN`, and auto-resumes a sleeping agent with
 * `202 + Retry-After`. Preferring `webUiUrl` is therefore what points the app
 * at the unified proxy. We still do NOT derive `https://<agentId>.<domain>`
 * ourselves when the server omits it: an agent record without a `webUiUrl`
 * (older rows, non-default base domains) is not guaranteed to have working
 * subdomain ingress, and a pinned 404 URL wedges first-run on
 * BACKEND_NOT_FOUND (a 404 is an HTTP response, so the startup
 * connection-error fallback deliberately does not catch it) — strictly worse
 * than the raw bridgeUrl, whose connection error the fallback recovers from.
 */
export function resolveCloudAgentApiBase(args: {
  bridgeUrl: string | null;
  webUiUrl?: string | null;
  /** Known agent id — used to derive a valid base when server URLs are missing
   *  or collapse to the agent-id-less collection URL. */
  agentId?: string | null;
  /** Resolved direct-cloud origin — required to derive from `agentId`. */
  cloudApiBase?: string | null;
}): string {
  const stripTrailingSlash = (u: string): string => u.replace(/\/+$/, "");
  const candidate =
    args.webUiUrl?.trim() || stripTrailingSlash(args.bridgeUrl ?? "");
  const normalized = candidate
    ? normalizeDirectCloudSharedAgentApiBase(stripTrailingSlash(candidate))
    : "";
  // A server URL that is missing/blank, or collapsed to the agent-id-less Eliza
  // Cloud collection (`.../api/v1/eliza/agents`), is unusable — every `/api/*`
  // call would concat to `.../agents/api/...` and 404. Derive the shared-runtime
  // REST adapter base from the known agent id instead. A raw dedicated bridge
  // (`http://<ip>:<port>`) is a valid base on a non-cloud host, so it is left
  // untouched (isElizaCloudControlPlaneAgentlessBase is host-checked).
  if (
    (!normalized || isElizaCloudControlPlaneAgentlessBase(normalized)) &&
    args.agentId &&
    args.cloudApiBase
  ) {
    return buildCloudSharedAgentApiBase(
      resolveDirectCloudAuthApiBase(args.cloudApiBase),
      args.agentId,
    );
  }
  return normalized;
}

function resolveDirectCloudAgentBridgeUrl(
  cloudApiBase: string,
  agentId: string,
): string {
  return `${cloudApiBase.replace(/\/+$/, "")}/api/v1/eliza/agents/${encodeURIComponent(agentId)}/bridge`;
}

function resolveDedicatedCloudAgentApiBase(args: {
  bridgeUrl: string | null;
  webUiUrl?: string | null;
  agentId: string;
  cloudApiBase: string;
}): string {
  const resolved = resolveCloudAgentApiBase(args);
  if (!isDirectCloudSharedAgentBase(resolved)) return resolved;
  return buildDedicatedCloudAgentApiBase(args.agentId) ?? resolved;
}

/**
 * True when `url` is a direct cloud shared-runtime agent base — either the REST
 * adapter base `<cloudApiBase>/api/v1/eliza/agents/<agentId>` (where #8527's
 * /api/conversations,/messages,/health are served) or the legacy JSON-RPC
 * bridge base `<...>/agents/<agentId>/bridge`. A Tier-0 shared agent runs
 * in-Worker with no agent server, so neither base exposes the app-shell
 * endpoints (`/api/first-run*`, `/api/views`) — those legitimately 404. Startup
 * uses this to degrade gracefully: a 404 from a shared-agent base means
 * "first-run is already complete" (we provisioned the agent), not a broken
 * backend — so it proceeds to chat instead of dead-ending on BACKEND_NOT_FOUND.
 */
export function isDirectCloudSharedAgentBase(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  return /\/api\/v1\/eliza\/agents\/[^/]+(?:\/bridge)?\/?$/.test(url.trim());
}

ElizaClient.prototype.provisionCloudSandbox = async (options) => {
  const { cloudApiBase, authToken, name, bio, onProgress } = options;
  const allowSharedRuntime = options.allowSharedRuntime === true;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  onProgress?.("creating", "Creating agent...");

  // Step 1: Create agent
  const createRes = await directCloudJsonResponse<{
    data?: { id?: string; agentId?: string };
    id?: string;
    agentId?: string;
  }>(`${resolvedCloudApiBase}/api/v1/eliza/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentName: name,
      alwaysOn: true,
      autoProvision: false,
      ...(bio?.length
        ? {
            agentConfig: {
              bio,
            },
          }
        : {}),
    }),
  });
  if (!createRes.ok) {
    const err = createRes.text || "Unknown error";
    throw new Error(`Failed to create cloud agent: ${err}`);
  }
  const createData = createRes.data;
  const agentId =
    createData.data?.id ??
    createData.data?.agentId ??
    createData.id ??
    createData.agentId;
  if (!agentId) {
    throw new Error("Failed to create cloud agent: missing agent id");
  }

  onProgress?.("provisioning", "Provisioning sandbox environment...");

  // Step 2: Start provisioning
  const provisionRes = await directCloudJsonResponse<{
    source?: string;
    data?: {
      jobId?: string;
      bridgeUrl?: string | null;
      webUiUrl?: string | null;
      executionTier?: string | null;
    };
    jobId?: string;
    bridgeUrl?: string | null;
    webUiUrl?: string | null;
    executionTier?: string | null;
  }>(`${resolvedCloudApiBase}/api/v1/eliza/agents/${agentId}/provision`, {
    method: "POST",
    headers,
  });
  if (!provisionRes.ok) {
    const err = provisionRes.text || "Unknown error";
    throw new Error(`Failed to start provisioning: ${err}`);
  }
  const provisionData = provisionRes.data;
  const immediateBridgeUrl =
    provisionData.data?.bridgeUrl ?? provisionData.bridgeUrl ?? null;
  const immediateWebUiUrl =
    provisionData.data?.webUiUrl ?? provisionData.webUiUrl ?? null;
  const executionTier =
    provisionData.data?.executionTier ?? provisionData.executionTier ?? null;
  const isSharedRuntime =
    provisionData.source === "shared_runtime" || executionTier === "shared";
  if (isSharedRuntime) {
    if (!allowSharedRuntime) {
      throw new Error(
        "Eliza Cloud returned a shared-runtime agent, but first-run requires a dedicated sandbox. Retry after provisioning capacity is healthy.",
      );
    }
    onProgress?.("ready", "Cloud agent ready!");
    // A shared agent has no agent server; the cloud-api REST adapter at
    // `<base>/api/v1/eliza/agents/<id>` serves its /api/* surface. Prefer the
    // server-provided webUiUrl; derive the same base if an older server omits
    // it (so chat works even before the create/provision response is updated).
    // resolveCloudAgentApiBase() prefers webUiUrl over bridgeUrl, so the REST
    // client targets the adapter while the bridgeUrl stays as a JSON-RPC
    // fallback for callers that explicitly allow shared runtime.
    const sharedWebUiUrl =
      immediateWebUiUrl ??
      `${resolvedCloudApiBase.replace(/\/+$/, "")}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
    return {
      bridgeUrl: resolveDirectCloudAgentBridgeUrl(
        resolvedCloudApiBase,
        agentId,
      ),
      agentId,
      webUiUrl: sharedWebUiUrl,
      executionTier: "shared",
    };
  }
  if (immediateBridgeUrl) {
    onProgress?.("ready", "Sandbox ready!");
    return {
      bridgeUrl: immediateBridgeUrl,
      agentId,
      webUiUrl: immediateWebUiUrl,
      ...(executionTier ? { executionTier } : {}),
    };
  }
  const jobId = provisionData.data?.jobId ?? provisionData.jobId;
  if (!jobId) {
    throw new Error("Failed to start provisioning: missing job id");
  }

  // Step 3: Poll job status
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const jobRes = await directCloudJsonResponse<{
      data?: {
        status?: string;
        result?: { bridgeUrl?: string; webUiUrl?: string | null };
        error?: string;
      };
      status?: string;
      result?: { bridgeUrl?: string; webUiUrl?: string | null };
      error?: string;
    }>(`${resolvedCloudApiBase}/api/v1/jobs/${jobId}`, { headers });
    if (!jobRes.ok) continue;

    const jobData = jobRes.data;
    const status = jobData.data?.status ?? jobData.status;
    const result = jobData.data?.result ?? jobData.result;
    const error = jobData.data?.error ?? jobData.error;

    if (status === "completed" && result?.bridgeUrl) {
      onProgress?.("ready", "Sandbox ready!");
      return {
        bridgeUrl: result.bridgeUrl as string,
        agentId,
        webUiUrl: result.webUiUrl ?? null,
      };
    }

    if (status === "failed") {
      throw new Error(`Provisioning failed: ${error ?? "Unknown error"}`);
    }

    onProgress?.("provisioning", `Status: ${status ?? "pending"}...`);
  }

  throw new Error("Provisioning timed out after 2 minutes");
};

// Dedicated cold-boot wait defaults. A dedicated container cold-starts in
// ~5 minutes (#8621, measured live 2026-06-19); the generic 202-retry budget in
// client-base is only ~60 s, so the connect flow must wait on the control plane
// instead of letting the first chat call exhaust that budget and error.
const CLOUD_AGENT_WAKE_POLL_INTERVAL_MS = 5_000;
const CLOUD_AGENT_WAKE_TIMEOUT_MS = 6 * 60_000;
const CLOUD_AGENT_FAILED_STATUSES = new Set([
  "error",
  "failed",
  "deletion_pending",
  "deletion_failed",
]);

function isTerminalFailedCloudAgent(agent: CloudCompatAgent): boolean {
  return CLOUD_AGENT_FAILED_STATUSES.has(
    String(agent.status ?? "").toLowerCase(),
  );
}

/**
 * Wait for a dedicated cloud agent to report `running` on the control plane,
 * kicking a resume first so a stopped/suspended container actually boots.
 *
 * The resume kick is best-effort: an agent already starting answers with an
 * idempotent "already in progress" envelope, and the dedicated-agent proxy
 * auto-resumes on first request anyway — the poll below is the source of
 * truth. Transient poll errors are tolerated (the timeout bounds them).
 *
 * Resolves with the FRESH agent record (post-wake URLs), so callers bind the
 * base the running container actually reports, not the stale list entry.
 * Throws on failed/deletion statuses and on timeout.
 */
export async function waitForCloudAgentRunning(
  client: ElizaClient,
  options: {
    agentId: string;
    pollIntervalMs?: number;
    timeoutMs?: number;
    onProgress?: (status: string, detail?: string) => void;
  },
): Promise<CloudCompatAgent> {
  const { agentId, onProgress } = options;
  const pollIntervalMs = Math.max(
    50,
    options.pollIntervalMs ?? CLOUD_AGENT_WAKE_POLL_INTERVAL_MS,
  );
  const timeoutMs = Math.max(
    pollIntervalMs,
    options.timeoutMs ?? CLOUD_AGENT_WAKE_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  onProgress?.(
    "starting",
    "Starting your agent — a cold boot can take a few minutes...",
  );
  // error-policy:J4 resume is an idempotent wake nudge — the status poll
  // below is the authority and surfaces failed/timed-out boots as errors.
  await client.resumeCloudCompatAgent(agentId).catch(() => null);

  let lastStatus = "unknown";
  for (;;) {
    // error-policy:J4 a failed status read counts as an unknown tick inside
    // this bounded poll; the deadline below throws with the last status.
    const detail = await client.getCloudCompatAgent(agentId).catch(() => null);
    const agent = detail?.success ? detail.data : null;
    if (agent) {
      lastStatus = agent.status || "unknown";
      if (lastStatus === "running") return agent;
      if (CLOUD_AGENT_FAILED_STATUSES.has(lastStatus)) {
        throw new Error(
          agent.error_message
            ? `Your cloud agent failed to start: ${agent.error_message}`
            : "Your cloud agent failed to start. Check its status in Eliza Cloud and try again.",
        );
      }
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs + pollIntervalMs > timeoutMs) {
      throw new Error(
        `Your cloud agent is still "${lastStatus}" after ${Math.round(
          elapsedMs / 1000,
        )}s. It may still be booting — try again in a minute.`,
      );
    }
    onProgress?.(
      "starting",
      `Starting your agent (${lastStatus}) — ${Math.round(elapsedMs / 1000)}s elapsed...`,
    );
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Pick which agent to reuse from a cloud agent list: a specific requested id
 * when it is running, else the most-recently-created running agent, else the
 * newest NON-TERMINAL agent (pending/provisioning/stopped/…). A running-only
 * pick (#15491) left any transiently-not-running account with zero reuse
 * candidates, so first-run fell through to a fresh create — which the server
 * 503-blocks during a provisioning-worker outage even though the user's
 * existing agent was fine (#15516). Non-running picks are never bound
 * directly: the reuse branch routes them through `waitForCloudAgentRunning`,
 * which resolves with the FRESH post-wake record — that (not refusing reuse)
 * is the guard against binding a stale pointer whose chat 404s. Failed and
 * deletion rows are unreusable.
 */
function pickPreferredCloudAgent(
  agents: CloudCompatAgent[],
  preferAgentId?: string | null,
): CloudCompatAgent | null {
  if (!agents.length) return null;
  const byNewest = (rows: CloudCompatAgent[]) =>
    [...rows].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at)),
    );
  if (preferAgentId) {
    // Honor the remembered agent whenever it is not terminally failed —
    // silently binding a DIFFERENT agent would swap the user's conversations
    // and memories; a cold-boot wait on the remembered one is the honest cost.
    const exact = agents.find(
      (a) => a.agent_id === preferAgentId && !isTerminalFailedCloudAgent(a),
    );
    if (exact) return exact;
  }
  const running = byNewest(agents.filter((a) => a.status === "running"));
  if (running[0]) return running[0];
  const nonTerminal = byNewest(
    agents.filter((a) => !isTerminalFailedCloudAgent(a)),
  );
  return nonTerminal[0] ?? null;
}

ElizaClient.prototype.selectOrProvisionCloudAgent = async function (
  this: ElizaClient,
  options,
) {
  const {
    cloudApiBase,
    authToken,
    name,
    bio,
    preferAgentId,
    forceCreate,
    preferSharedTier,
    knownAgents,
    preferStewardAgentAdapter,
  } = options;
  const onProgress = options.onProgress;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  let forceCreateForTerminalAgents = false;
  // Ensure the direct-cloud requests below authenticate even on a cold boot,
  // where the resolved token may be empty (the caller always passes the session
  // token). Persist it through the canonical steward-session store so
  // getCloudAuthToken() resolves it for those requests.
  if (authToken) {
    writeStoredStewardToken(authToken);
  }

  // Reuse an existing agent unless the caller explicitly forces a new one. This
  // is the fix for "a new cloud agent is created on every sign-in" — the create
  // path only runs when the user has no agent yet.
  if (!forceCreate) {
    const list = knownAgents
      ? { success: true as const, data: knownAgents }
      : await (async () => {
          // "listing", not "creating": this is the reuse LOOKUP, and
          // downstream consumers (the first-run silent cloud entry, #15133)
          // distinguish real provisioning phases from bookkeeping by this code.
          // Display consumers render the detail text, so the rename is
          // invisible to them.
          onProgress?.("listing", "Finding your agents...");
          // A failed agent-list lookup must NOT fall through to provisioning. A
          // transient error (expired token, network blip, or a success:false
          // body) previously collapsed to an empty list and minted a brand-new
          // billed agent even though the user already had one — the root of the
          // "it creates multiple agents" report. Only an authoritative success
          // list may conclude the user has no agent to reuse; otherwise surface
          // the error so the caller can retry rather than duplicate.
          return await this.getCloudCompatAgents().catch((cause) => ({
            success: false as const,
            data: [] as CloudCompatAgent[],
            error: cause instanceof Error ? cause.message : undefined,
          }));
        })();
    if (!list.success) {
      throw new Error(
        list.error ||
          "Couldn't reach Eliza Cloud to find your agents. Check your connection and try again.",
      );
    }
    const chosen = pickPreferredCloudAgent(list.data, preferAgentId);
    forceCreateForTerminalAgents =
      list.data.length > 0 &&
      !chosen &&
      list.data.every(isTerminalFailedCloudAgent);
    if (chosen) {
      let agent = chosen;
      // A picked agent that is not `running` is a dedicated cold boot: shared
      // rows are BORN `running` (they are container-free, served instantly by
      // the in-Worker runtime), so a non-running pick always has a container
      // to wake (~5 minutes — #8621). Binding its list-row base immediately
      // would exhaust the ~60 s 202-retry budget on the first chat call AND
      // risks a stale pointer (the list row's URLs predate the wake) — so wait
      // for `running` here; `waitForCloudAgentRunning` kicks a resume and
      // resolves with the FRESH post-wake record, whose URLs we bind below.
      if (agent.status !== "running") {
        agent = await waitForCloudAgentRunning(this, {
          agentId: chosen.agent_id,
          ...(typeof options.wakePollIntervalMs === "number"
            ? { pollIntervalMs: options.wakePollIntervalMs }
            : {}),
          ...(typeof options.wakeTimeoutMs === "number"
            ? { timeoutMs: options.wakeTimeoutMs }
            : {}),
          ...(onProgress ? { onProgress } : {}),
        });
      }
      const hasDedicatedBase = Boolean(
        agent.bridge_url || agent.web_ui_url || agent.webUiUrl,
      );
      const useSharedAdapter = Boolean(
        !hasDedicatedBase && (preferSharedTier || preferStewardAgentAdapter),
      );
      const apiBase = useSharedAdapter
        ? buildCloudSharedAgentApiBase(resolvedCloudApiBase, agent.agent_id)
        : resolveDedicatedCloudAgentApiBase({
            bridgeUrl: agent.bridge_url,
            webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
            agentId: agent.agent_id,
            cloudApiBase: resolvedCloudApiBase,
          });
      onProgress?.("ready", "Connected to your agent");
      return {
        agentId: agent.agent_id,
        agentName: agent.agent_name,
        apiBase,
        bridgeUrl: agent.bridge_url,
        created: false,
        requiresAgentPairing: false,
      };
    }
  }

  // Create a NEW agent. createCloudCompatAgent provisions a DEDICATED (alwaysOn)
  // agent — the billed container product served at its own public subdomain
  // (https://<id>.elizacloud.ai), reached with the cloud token via the
  // unified-auth Worker. A dedicated agent's reachable base is that subdomain,
  // NOT the shared REST adapter (which 404s for non-shared agents), so resolve
  // the base from the agent's web_ui_url exactly like the reuse branch above.
  // The subdomain is returned as soon as the agent record exists (before the
  // container finishes booting), so re-read the created agent to pick it up;
  // if that lookup fails or has no URL yet, fall back to the standard dedicated
  // subdomain for the known agent id.
  onProgress?.("creating", `Creating ${name}...`);
  const created = await this.createCloudCompatAgent({
    agentName: name,
    ...(bio?.length ? { agentConfig: { bio } } : {}),
    ...(forceCreate || (forceCreateForTerminalAgents && !preferSharedTier)
      ? { forceCreate: true }
      : {}),
    ...(preferSharedTier ? { preferSharedTier: true } : {}),
  });
  if (!created.success || !created.data.agentId) {
    throw new Error(created.data.message || "Failed to create cloud agent");
  }
  const agentId = created.data.agentId;
  // error-policy:J4 detail is an optimization probe (warm-pool fast path);
  // on failure the standard dedicated subdomain is still the desired default.
  const detail = await this.getCloudCompatAgent(agentId).catch(() => null);
  let detailAgent = detail?.success ? detail.data : null;
  const detailHasDedicatedBase = Boolean(
    detailAgent?.bridge_url || detailAgent?.web_ui_url || detailAgent?.webUiUrl,
  );
  const useSharedAdapter = Boolean(
    !detailHasDedicatedBase && (preferSharedTier || preferStewardAgentAdapter),
  );
  // A freshly-created dedicated agent's subdomain is populated immediately, but
  // its container takes ~30-120s to boot. When the caller wants a dedicated
  // runtime, wait here so the first chat request does not land on the shared
  // adapter for a non-shared agent or race the container cold boot.
  const initialDedicatedApiBase = resolveDedicatedCloudAgentApiBase({
    bridgeUrl: detailAgent?.bridge_url ?? null,
    webUiUrl: detailAgent?.web_ui_url ?? detailAgent?.webUiUrl,
    agentId,
    cloudApiBase: resolvedCloudApiBase,
  });
  if (
    !useSharedAdapter &&
    detailAgent &&
    detailAgent.status !== "running" &&
    isDedicatedCloudAgentBase(initialDedicatedApiBase)
  ) {
    detailAgent = await waitForCloudAgentRunning(this, {
      agentId,
      ...(typeof options.wakePollIntervalMs === "number"
        ? { pollIntervalMs: options.wakePollIntervalMs }
        : {}),
      ...(typeof options.wakeTimeoutMs === "number"
        ? { timeoutMs: options.wakeTimeoutMs }
        : {}),
      ...(onProgress ? { onProgress } : {}),
    });
  }
  const apiBase = useSharedAdapter
    ? buildCloudSharedAgentApiBase(resolvedCloudApiBase, agentId)
    : resolveDedicatedCloudAgentApiBase({
        bridgeUrl: detailAgent?.bridge_url ?? null,
        webUiUrl: detailAgent?.web_ui_url ?? detailAgent?.webUiUrl,
        agentId,
        cloudApiBase: resolvedCloudApiBase,
      });
  onProgress?.("ready", "Cloud agent ready!");
  return {
    agentId,
    agentName: created.data.agentName || name,
    apiBase,
    bridgeUrl: detailAgent?.bridge_url ?? null,
    // Report what the backend ACTUALLY did, not what we asked for. When the org
    // is at its per-org cap (#11023) the create POST returns 200 `created:
    // false` (the reuse guard handed back the existing agent), and the caller's
    // "created a new agent" affordance must not lie about it (#14487). Only an
    // explicit `false` demotes to reuse; an absent flag (older worker) stays
    // `true` so the pre-existing create UX is unchanged.
    created: created.created !== false,
    requiresAgentPairing: false,
  };
};

ElizaClient.prototype.startCloudAgentHandoff = function (
  this: ElizaClient,
  options,
) {
  const {
    agentId,
    sharedApiBase,
    conversationId,
    cloudApiBase,
    authToken,
    dedicatedAgentId,
    onSwitch,
    intervalMs,
    timeoutMs,
    log,
  } = options;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  // Migration TARGET. With the shared tier, the user chats on `agentId` (a
  // container-free shared agent that never gets a dedicated base), so the
  // dedicated record we poll for readiness is a SEPARATE agent. Default to
  // `agentId` so the pre-shared-tier single-agent flow is unchanged.
  const readinessAgentId = dedicatedAgentId ?? agentId;

  // Authed JSON fetch against a specific agent base (shared adapter OR the
  // dedicated container subdomain). Both accept the cloud session token —
  // the dedicated-agent proxy swaps it for the container's own token.
  const authedFetch: AuthedAgentFetch = async (base, path, init) => {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  const readiness: AgentReadinessProbe = {
    resolveReadyBase: async () => {
      const detail = await this.getCloudCompatAgent(readinessAgentId).catch(
        () => null,
      );
      const agent = detail?.success ? detail.data : null;
      if (!agent) return null;
      // The container is "ready" only once the record exposes a dedicated base
      // (bridge/web-ui subdomain) AND reports running — until then the user is
      // served by the shared adapter.
      const hasDedicatedUrl = Boolean(
        agent.bridge_url || agent.web_ui_url || agent.webUiUrl,
      );
      if (!hasDedicatedUrl) return null;
      if (agent.status && agent.status !== "running") return null;
      const base = resolveCloudAgentApiBase({
        bridgeUrl: agent.bridge_url,
        webUiUrl: agent.web_ui_url ?? agent.webUiUrl,
        agentId: readinessAgentId,
        cloudApiBase: resolvedCloudApiBase,
      });
      // Never "switch" onto the shared adapter (no migration target there).
      if (isDirectCloudSharedAgentBase(base)) return null;
      // Control-plane `running` precedes actual routability: the runtime proxy
      // can keep 404ing the subdomain for minutes after the record flips
      // (#15901). Probe the base itself and only report ready once the proxy
      // actually routes to the container — a 404/408/425/429/5xx or a
      // network-layer failure means "running but not yet routable", so the
      // supervisor keeps polling inside its budget instead of one-shot
      // importing into a router that answers 404. Any routed response —
      // including an auth challenge — proves routability; the import carries
      // its own credentials.
      try {
        const probe = await authedFetch(base, "/api/health");
        if (isRetryableHandoffHttpStatus(probe.status)) return null;
      } catch {
        // error-policy:J4 readiness probe — an unreachable base is the
        // designed "not ready yet" signal; the poll loop retries within its
        // budget and times out honestly if the container never serves.
        return null;
      }
      return base;
    },
  };

  return startCloudConversationHandoff({
    sharedApiBase,
    conversationId,
    readiness,
    authedFetch,
    onSwitch,
    ...(typeof intervalMs === "number" ? { intervalMs } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(log ? { log } : {}),
  });
};

ElizaClient.prototype.deleteSharedBridgeAgent = async function (
  this: ElizaClient,
  agentId,
  options,
) {
  // Pin to the explicit cloud API base, not the client's (now repointed-to-
  // dedicated) baseUrl. The shared-tier DELETE on `/api/v1/eliza/agents/:id`
  // synchronously removes the shared `agent_sandboxes` row AND its
  // `shared_runtime_history` (cascaded in `deleteAgent`); no container teardown.
  const apiBase = resolveDirectCloudAuthApiBase(options.cloudApiBase);
  const url = `${apiBase}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.authToken}`,
  };
  try {
    // Route through Capacitor native HTTP on iOS/Android, exactly like every
    // other direct-cloud helper in this file. A bare cross-origin `fetch()`
    // from `capacitor://localhost` is blocked on native, so without this the
    // fire-and-forget cleanup would silently no-op on mobile and leak the
    // shared `agent_sandboxes` row — the very thing this delete exists to avoid.
    const status = shouldUseNativeCloudHttp()
      ? (
          await withDirectCloudHttpTimeout(
            CapacitorHttp.request({
              url,
              method: "DELETE",
              headers,
              responseType: "json",
              connectTimeout: 10_000,
              readTimeout: 10_000,
            }),
            { method: "DELETE", url },
          )
        ).status
      : (
          await fetch(resolveBrowserCloudApiRequestUrl(url), {
            method: "DELETE",
            headers,
            signal: AbortSignal.timeout(20_000),
          })
        ).status;
    if (status < 200 || status >= 300) {
      return {
        success: false,
        error: `shared bridge delete failed (HTTP ${status})`,
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

ElizaClient.prototype.checkBugReportInfo = async function (this: ElizaClient) {
  return this.fetch("/api/bug-report/info");
};

ElizaClient.prototype.submitBugReport = async function (
  this: ElizaClient,
  report,
) {
  return this.fetch("/api/bug-report", {
    method: "POST",
    body: JSON.stringify(report),
  });
};
