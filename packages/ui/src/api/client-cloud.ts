/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  readStoredStewardToken,
  STEWARD_REFRESH_ENDPOINT,
} from "@elizaos/shared/steward-session-client";
import { getBootConfig } from "../config/boot-config";
import {
  buildCloudSharedAgentApiBase,
  isElizaCloudControlPlaneAgentlessBase,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { ElizaClient } from "./client-base";
import type {
  ApiError,
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
const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://www.elizacloud.ai";
const DEFAULT_DIRECT_CLOUD_API_BASE_URL = "https://api.elizacloud.ai";
const DIRECT_CLOUD_HTTP_TIMEOUT_MS = 15_000;
const DIRECT_ELIZA_CLOUD_WEB_HOSTS = new Set([
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);
const DIRECT_ELIZA_CLOUD_API_HOST = "api.elizacloud.ai";

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

type ProvisioningAgentStatusData = {
  status?: string;
  bridgeUrl?: string | null;
  webUiUrl?: string | null;
  agentId?: string | null;
};

type ProvisioningAgentChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ProvisioningAgentChatData = {
  reply?: string;
  containerStatus?: string;
  bridgeUrl?: string | null;
  webUiUrl?: string | null;
  agentId?: string | null;
  history?: ProvisioningAgentChatMessage[];
};

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
    return (
      host === DIRECT_ELIZA_CLOUD_API_HOST ||
      DIRECT_ELIZA_CLOUD_WEB_HOSTS.has(host)
    );
  } catch {
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

function errorStringOrNull(value: unknown): string | null {
  const direct = stringOrNull(value);
  if (direct) return direct;
  const record = recordOrNull(value);
  if (!record) return null;
  return firstString(record.error, record.message, record.reason);
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

function shouldUseNativeCloudHttp(): boolean {
  return Capacitor.isNativePlatform();
}

function resolveDirectCloudWebBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const host = new URL(normalized).hostname.toLowerCase();
    if (host === DIRECT_ELIZA_CLOUD_API_HOST) {
      return DEFAULT_DIRECT_CLOUD_BASE_URL;
    }
  } catch {
    // Fall back to the provided base below.
  }
  return normalized;
}

function resolveDirectCloudAuthApiBase(cloudBase: string): string {
  const normalized = cloudBase.replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    if (
      host === DIRECT_ELIZA_CLOUD_API_HOST ||
      DIRECT_ELIZA_CLOUD_WEB_HOSTS.has(host)
    ) {
      return DEFAULT_DIRECT_CLOUD_API_BASE_URL;
    }
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
 * The legacy `__ELIZA_CLOUD_AUTH_TOKEN__` global and the client REST token are
 * kept only as fallbacks for the Remote (device-code/pairing) flow, which still
 * mints its own session token via `cloudLoginPollDirect`.
 */
export function getCloudAuthToken(client?: ElizaClient): string | null {
  const stewardToken = readStoredStewardToken()?.trim();
  if (stewardToken) return stewardToken;

  const globalToken = (globalThis as Record<string, unknown>)
    .__ELIZA_CLOUD_AUTH_TOKEN__;
  if (typeof globalToken === "string" && globalToken.trim()) {
    return globalToken.trim();
  }

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
  if (typeof fetch === "undefined") return null;
  const endpoint = opts?.endpoint ?? STEWARD_REFRESH_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) return null;
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

  const res = await fetchDirectCloudWithTimeout(
    url,
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

  const res = await fetchDirectCloudWithTimeout(
    url,
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
    id: requireString(data.id, "data.id"),
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
    }>;
    createCloudCompatAgent(opts: {
      agentName: string;
      agentConfig?: Record<string, unknown>;
      environmentVars?: Record<string, string>;
    }): Promise<{
      success: boolean;
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
    getProvisioningAgentStatus(agentId?: string): Promise<{
      success: boolean;
      data: ProvisioningAgentStatusData;
    }>;
    sendProvisioningAgentMessage(
      message: string,
      agentId?: string,
    ): Promise<{
      success: boolean;
      data: ProvisioningAgentChatData;
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
    /**
     * Fetch a pairing token for a cloud agent. When the agent is not running,
     * the server kicks off a resume and returns a 202 `{ status: "starting",
     * jobId, retryAfterMs }` body instead of a token — poll again after the
     * suggested interval. See `pairDedicatedCloudAgent` for the full loop.
     */
    getCloudCompatPairingToken(agentId: string): Promise<{
      success: boolean;
      data: {
        token?: string;
        redirectUrl?: string;
        expiresIn?: number;
        status?: string;
        jobId?: string;
        retryAfterMs?: number;
        message?: string;
      };
      error?: string;
    }>;
    /**
     * Resume (if needed), wait until running, then pair with a DEDICATED cloud
     * agent and return the bind target. A dedicated agent is a full app-server
     * with its own auth, so binding needs the agent's own API token (obtained by
     * exchanging a one-time pairing token), not the cloud token. Drives the
     * self-healing `pairing-token` endpoint: polls through the cold-boot
     * (~5 min) `202 starting` responses, then exchanges the token at the cloud
     * `/api/auth/pair` relay for the agent's API key.
     *
     * Resolves to `{ status: "paired", apiBase, agentToken }` to bind, or
     * `{ status: "manual_auth", webUiUrl }` when the agent only offers its own
     * password screen (no token pairing). Throws on timeout / hard failure.
     */
    pairDedicatedCloudAgent(
      agentId: string,
      options?: {
        onProgress?: (status: string, detail?: string) => void;
        timeoutMs?: number;
        signal?: AbortSignal;
      },
    ): Promise<
      | {
          status: "paired";
          apiBase: string;
          agentToken: string;
          agentName?: string;
        }
      | { status: "manual_auth"; webUiUrl: string }
    >;
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
      onProgress?: (status: string, detail?: string) => void;
    }): Promise<{
      agentId: string;
      agentName: string;
      apiBase: string;
      bridgeUrl: string | null;
      created: boolean;
    }>;
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
      const balance =
        typeof data?.balance === "number"
          ? data.balance
          : typeof data?.balance === "string"
            ? Number(data.balance)
            : null;
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
    const balance =
      typeof organization.creditBalance === "number"
        ? organization.creditBalance
        : typeof organization.creditBalance === "string"
          ? Number(organization.creditBalance)
          : null;
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
  const direct = await directCloudRequest<{
    success: boolean;
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
      alwaysOn: true,
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
      data: unknown;
      error?: string;
    }>("/api/v1/eliza/agents", {
      method: "POST",
      body: JSON.stringify({
        agentName: opts.agentName,
        // Dedicated (own-container, always-on) agent — see the direct-path note.
        alwaysOn: true,
        ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
        ...(opts.environmentVars
          ? { environmentVars: opts.environmentVars }
          : {}),
      }),
    });
    const data = parseDirectCloudAgentCreateData(response.data, opts.agentName);
    return {
      success: response.success,
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
    data?: { message?: string; status?: string };
    error?: string;
  }) => ({
    success: response.success === true,
    ...(response.error ? { error: response.error } : {}),
    data: {
      jobId: "",
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
    data?: { message?: string; status?: string };
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
      data?: { message?: string; status?: string };
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

ElizaClient.prototype.getProvisioningAgentStatus = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data?: ProvisioningAgentStatusData;
  }>(this, "/api/v1/provisioning-agent");
  if (direct) return { success: direct.success, data: direct.data ?? {} };

  try {
    return await this.fetch<{
      success: boolean;
      data: ProvisioningAgentStatusData;
    }>("/api/v1/provisioning-agent");
  } catch (error) {
    if (!agentId || !isCloudRouteNotFound(error)) throw error;

    const compat = await this.getCloudCompatAgentStatus(agentId);
    return {
      success: compat.success,
      data: {
        status: compat.data.status,
        bridgeUrl: compat.data.bridgeUrl ?? null,
        webUiUrl: compat.data.webUiUrl ?? null,
        agentId,
      },
    };
  }
};

ElizaClient.prototype.sendProvisioningAgentMessage = async function (
  this: ElizaClient,
  message,
  agentId,
) {
  const body = JSON.stringify({
    message,
    ...(agentId ? { agentId } : {}),
  });
  const direct = await directCloudRequest<{
    success: boolean;
    data?: ProvisioningAgentChatData;
  }>(this, "/api/v1/provisioning-agent/chat", {
    method: "POST",
    body,
  });
  if (direct) return { success: direct.success, data: direct.data ?? {} };

  return this.fetch<{
    success: boolean;
    data: ProvisioningAgentChatData;
  }>("/api/v1/provisioning-agent/chat", {
    method: "POST",
    body,
  });
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

ElizaClient.prototype.restartCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/restart`,
    { method: "POST" },
  );
};

ElizaClient.prototype.suspendCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/suspend`,
    { method: "POST" },
  );
};

ElizaClient.prototype.resumeCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/resume`,
    { method: "POST" },
  );
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

ElizaClient.prototype.getCloudCompatPairingToken = async function (
  this: ElizaClient,
  agentId,
) {
  const direct = await directCloudRequest<{
    success: boolean;
    data: {
      token: string;
      redirectUrl: string;
      expiresIn: number;
      status?: string;
      jobId?: string;
      retryAfterMs?: number;
      message?: string;
    };
    error?: string;
  }>(
    this,
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/pairing-token`,
    { method: "POST" },
  );
  if (direct) return direct;

  if (isNativeDirectCloudAuthMissing(this)) {
    return {
      success: false,
      data: { token: "", redirectUrl: "", expiresIn: 0 },
      error: nativeDirectCloudAuthMissingMessage(),
    };
  }

  if (isDirectCloudBase(this)) {
    return this.fetch(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/pairing-token`,
      { method: "POST" },
      { allowNonOk: true },
    );
  }

  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/pairing-token`,
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
        browserUrl: `${cloudWebBase}/auth/cli-login?session=${encodeURIComponent(sessionId)}`,
      };
    }

    const res = await fetch(`${authApiBase}/api/auth/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      return { ok: false, error: `Login failed (${res.status})` };
    }
    return {
      ok: true,
      apiBase: authApiBase,
      sessionId,
      browserUrl: `${cloudWebBase}/auth/cli-login?session=${encodeURIComponent(sessionId)}`,
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
      const data = res.data;
      if (data.status === "authenticated" && data.apiKey) {
        return {
          status: "authenticated" as const,
          organizationId: data.organizationId,
          token: data.apiKey,
          userId: data.userId,
        };
      }
      return { status: data.status || "pending" };
    }

    const res = await fetch(
      `${authApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
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
    const data = await res.json();
    if (data.status === "authenticated" && data.apiKey) {
      return {
        status: "authenticated" as const,
        organizationId: data.organizationId,
        token: data.apiKey,
        userId: data.userId,
      };
    }
    return { status: data.status ?? ("pending" as const) };
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
 * We deliberately do NOT derive `https://<agentId>.<domain>` ourselves.
 * Verified against live Eliza Cloud (2026-05-31): a running agent is exposed
 * ONLY as `bridgeUrl: http://<ip>:<port>` (no `web_ui_url` field), and the
 * per-agent subdomain the cloud code *intends* — `<agentId>.elizacloud.ai`,
 * built by getElizaAgentPublicWebUiUrl() — is not actually deployed: it returns
 * a Vercel `DEPLOYMENT_NOT_FOUND` 404. Pinning that 404 URL would wedge
 * first-run on BACKEND_NOT_FOUND (a 404 is an HTTP response, so the startup
 * connection-error fallback in startup-phase-poll deliberately does NOT catch
 * it) — strictly worse than the raw bridgeUrl, whose connection error the
 * fallback recovers from. If/when the cloud deploys that gateway and returns a
 * real `webUiUrl`, this picks it up automatically with no further change.
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

/**
 * Pick which agent to reuse from a cloud agent list: a specific requested id if
 * it still exists, else the most-recently-created "running" agent, else the
 * most recent of any status.
 */
function pickPreferredCloudAgent(
  agents: CloudCompatAgent[],
  preferAgentId?: string | null,
): CloudCompatAgent | null {
  if (!agents.length) return null;
  if (preferAgentId) {
    const exact = agents.find((a) => a.agent_id === preferAgentId);
    if (exact) return exact;
  }
  const byNewest = [...agents].sort((a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)),
  );
  return byNewest.find((a) => a.status === "running") ?? byNewest[0] ?? null;
}

ElizaClient.prototype.selectOrProvisionCloudAgent = async function (
  this: ElizaClient,
  options,
) {
  const { cloudApiBase, authToken, name, bio, preferAgentId, forceCreate } =
    options;
  const onProgress = options.onProgress;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  // Ensure the direct-cloud requests below authenticate even on a cold boot,
  // where the runtime global token may be empty (the caller always passes the
  // session token).
  if (authToken && typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
      authToken;
  }

  // Reuse an existing agent unless the caller explicitly forces a new one. This
  // is the fix for "a new cloud agent is created on every sign-in" — the create
  // path only runs when the user has no agent yet.
  if (!forceCreate) {
    onProgress?.("creating", "Finding your agents...");
    const list = await this.getCloudCompatAgents().catch(() => null);
    const agents = list?.success ? list.data : [];
    const chosen = pickPreferredCloudAgent(agents, preferAgentId);
    if (chosen) {
      const apiBase = resolveCloudAgentApiBase({
        bridgeUrl: chosen.bridge_url,
        webUiUrl: chosen.web_ui_url ?? chosen.webUiUrl,
        agentId: chosen.agent_id,
        cloudApiBase: resolvedCloudApiBase,
      });
      onProgress?.("ready", "Connected to your agent");
      return {
        agentId: chosen.agent_id,
        agentName: chosen.agent_name,
        apiBase,
        bridgeUrl: chosen.bridge_url,
        created: false,
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
  // if that lookup fails or has no URL yet, fall back to the shared-adapter base.
  onProgress?.("creating", `Creating ${name}...`);
  const created = await this.createCloudCompatAgent({
    agentName: name,
    ...(bio?.length ? { agentConfig: { bio } } : {}),
  });
  if (!created.success || !created.data.agentId) {
    throw new Error(created.data.message || "Failed to create cloud agent");
  }
  const agentId = created.data.agentId;
  const detail = await this.getCloudCompatAgent(agentId).catch(() => null);
  const detailAgent = detail?.success ? detail.data : null;
  const apiBase =
    detailAgent?.web_ui_url || detailAgent?.bridge_url
      ? resolveCloudAgentApiBase({
          bridgeUrl: detailAgent.bridge_url,
          webUiUrl: detailAgent.web_ui_url ?? detailAgent.webUiUrl,
          agentId,
          cloudApiBase: resolvedCloudApiBase,
        })
      : buildCloudSharedAgentApiBase(resolvedCloudApiBase, agentId);
  onProgress?.("ready", "Cloud agent ready!");
  return {
    agentId,
    agentName: created.data.agentName || name,
    apiBase,
    bridgeUrl: detailAgent?.bridge_url ?? null,
    created: true,
  };
};

/** Strip a `/pair?token=…` redirect down to the agent's own origin. */
function dedicatedAgentOriginFromRedirect(redirectUrl: string): string {
  return new URL(redirectUrl).origin;
}

/**
 * Exchange a one-time pairing token for the dedicated agent's API key via the
 * cloud `/api/auth/pair` relay. The token is origin-bound, so the request MUST
 * carry an `Origin` header matching the agent web UI origin. A browser `fetch`
 * cannot set `Origin` (forbidden header), so the native path calls
 * `CapacitorHttp` directly (it preserves the header); on the web the browser
 * supplies its own origin, which only matches when the SPA is served from the
 * agent origin. The exchange itself is unauthenticated — the pairing token is
 * the credential.
 */
async function exchangeCloudPairingToken(args: {
  cloudApiBase: string;
  token: string;
  agentOrigin: string;
}): Promise<{ apiKey: string; agentName?: string }> {
  const url = `${args.cloudApiBase.replace(/\/+$/, "")}/api/auth/pair`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: args.agentOrigin,
  };
  const bodyObj = { token: args.token };

  let status: number;
  let parsed: { apiKey?: string | null; agentName?: string; error?: string };
  if (shouldUseNativeCloudHttp()) {
    const res = await withDirectCloudHttpTimeout(
      CapacitorHttp.request({
        url,
        method: "POST",
        headers,
        data: bodyObj,
        responseType: "json",
        connectTimeout: 15_000,
        readTimeout: 15_000,
      }),
      { method: "POST", url },
    );
    status = res.status;
    parsed = (parseDirectCloudJsonSafe(res.data) ?? {}) as typeof parsed;
  } else {
    const res = await fetchDirectCloudWithTimeout(
      url,
      { method: "POST", headers, body: JSON.stringify(bodyObj) },
      { method: "POST", url },
    );
    status = res.status;
    parsed = (await res.json().catch(() => ({}))) as typeof parsed;
  }

  if (status === 401 || status === 403 || status === 410) {
    throw new Error(
      "Pairing link expired before sign-in completed. Try connecting again.",
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      parsed.error || `Agent pairing exchange failed (${status}).`,
    );
  }
  const apiKey = parsed.apiKey;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error(
      "Eliza Cloud accepted the pairing link but returned no agent key.",
    );
  }
  return { apiKey, agentName: parsed.agentName };
}

ElizaClient.prototype.pairDedicatedCloudAgent = async function (
  this: ElizaClient,
  agentId,
  options,
) {
  const onProgress = options?.onProgress;
  // Cold boot of a dedicated container is ~5 min; give it headroom.
  const deadline = Date.now() + (options?.timeoutMs ?? 6 * 60_000);
  const cloudApiBase = resolveDirectCloudClientApiBase(this);
  if (!cloudApiBase) {
    throw new Error("Not signed in to Eliza Cloud.");
  }

  let token = "";
  let redirectUrl = "";

  // Phase 1: resume (server-side, automatic) + wait until the agent is running.
  // The pairing-token endpoint returns a 202 `starting` body while the agent
  // boots and a token once it is running.
  for (;;) {
    options?.signal?.throwIfAborted?.();
    const res = await this.getCloudCompatPairingToken(agentId);
    if (!res.success) {
      throw new Error(res.error || "Failed to start the cloud agent.");
    }
    const data = res.data ?? {};
    if (data.token && data.redirectUrl) {
      token = data.token;
      redirectUrl = data.redirectUrl;
      break;
    }
    onProgress?.(
      data.status || "starting",
      data.message || "Waking your agent…",
    );
    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for the cloud agent to start. Try again in a moment.",
      );
    }
    const waitMs = Math.min(Math.max(data.retryAfterMs ?? 5000, 1000), 15_000);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const agentOrigin = dedicatedAgentOriginFromRedirect(redirectUrl);

  // When the agent has no UI-token pairing configured the server returns the
  // bare web UI URL (no `/pair?token=`). That agent uses its own password
  // screen — we cannot bind headlessly, so hand the URL back to the caller.
  if (!/\/pair\b/.test(new URL(redirectUrl).pathname)) {
    onProgress?.("manual_auth", "This agent uses its own sign-in.");
    return { status: "manual_auth", webUiUrl: agentOrigin };
  }

  // Phase 2: trade the one-time token for the agent's own API key and bind.
  onProgress?.("pairing", "Signing in to your agent…");
  const exchanged = await exchangeCloudPairingToken({
    cloudApiBase,
    token,
    agentOrigin,
  });
  onProgress?.("ready", "Connected.");
  return {
    status: "paired",
    apiBase: agentOrigin,
    agentToken: exchanged.apiKey,
    agentName: exchanged.agentName,
  };
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
