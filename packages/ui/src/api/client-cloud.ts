/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { getBootConfig } from "../config/boot-config";
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

function readDirectCloudToken(client: ElizaClient): string | null {
  const globalToken = (globalThis as Record<string, unknown>)
    .__ELIZA_CLOUD_AUTH_TOKEN__;
  if (typeof globalToken === "string" && globalToken.trim()) {
    return globalToken.trim();
  }

  const clientToken = client.getRestAuthToken()?.trim();
  return clientToken || null;
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
      ok: res.status >= 200 && res.status < 300,
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
    ok: res.ok,
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
 * Eliza Cloud's REST envelopes return `{ success: true, ... }` even when
 * the HTTP status is non-2xx — most commonly 202 (job enqueued) and 409
 * (provisioning already in progress, jobId still useful for polling). The
 * legacy strict-2xx check threw on those bodies and stranded callers like
 * `provisionAndConnect` mid-await with no jobId, surfacing as an "infinite
 * Starting provisioning…" UI hang. Accept any response whose body claims
 * `success: true` regardless of status, and any 2xx response otherwise.
 */
function isAcceptableDirectCloudResponse(
  status: number,
  body: unknown,
): boolean {
  if (status >= 200 && status < 300) return true;
  if (typeof body !== "object" || body === null) return false;
  return (body as { success?: unknown }).success === true;
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

function toCloudCompatAgent(input: DirectCloudAgent): CloudCompatAgent {
  const id = stringOrNull(input.agentId) ?? stringOrNull(input.id) ?? "";
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
  const id = firstString(input.id, input.jobId, input.job_id, data.id) ?? "";
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
    /** Fetch a pairing token for a cloud agent (for opening Web UI in a new tab). */
    getCloudCompatPairingToken(agentId: string): Promise<{
      success: boolean;
      data: { token: string; redirectUrl: string; expiresIn: number };
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
    }): Promise<{ bridgeUrl: string; agentId: string }>;
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
    data?: {
      id?: string;
      agentName?: string;
      status?: string;
    };
    error?: string;
  }>(this, "/api/v1/eliza/agents", {
    method: "POST",
    body: JSON.stringify({
      agentName: opts.agentName,
      ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
      ...(opts.environmentVars
        ? { environmentVars: opts.environmentVars }
        : {}),
    }),
  });
  if (direct) {
    const agentId = direct.data?.id ?? "";
    return {
      success: direct.success,
      data: {
        agentId,
        agentName: direct.data?.agentName ?? opts.agentName,
        jobId: "",
        status: direct.data?.status ?? "pending",
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
      data?: {
        id?: string;
        agentName?: string;
        status?: string;
      };
      error?: string;
    }>("/api/v1/eliza/agents", {
      method: "POST",
      body: JSON.stringify({
        agentName: opts.agentName,
        ...(opts.agentConfig ? { agentConfig: opts.agentConfig } : {}),
        ...(opts.environmentVars
          ? { environmentVars: opts.environmentVars }
          : {}),
      }),
    });
    const agentId = response.data?.id ?? "";
    return {
      success: response.success,
      data: {
        agentId,
        agentName: response.data?.agentName ?? opts.agentName,
        jobId: "",
        status: response.data?.status ?? "pending",
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

ElizaClient.prototype.provisionCloudSandbox = async (options) => {
  const { cloudApiBase, authToken, name, bio, onProgress } = options;
  const resolvedCloudApiBase = resolveDirectCloudAuthApiBase(cloudApiBase);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  onProgress?.("creating", "Creating agent...");

  // Step 1: Create agent
  const createRes = await directCloudJsonResponse<{
    data?: { id?: string };
    id?: string;
  }>(`${resolvedCloudApiBase}/api/v1/eliza/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agentName: name,
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
  const agentId = createData.data?.id ?? createData.id;
  if (!agentId) {
    throw new Error("Failed to create cloud agent: missing agent id");
  }

  onProgress?.("provisioning", "Provisioning sandbox environment...");

  // Step 2: Start provisioning
  const provisionRes = await directCloudJsonResponse<{
    data?: {
      jobId?: string;
      bridgeUrl?: string | null;
    };
    jobId?: string;
    bridgeUrl?: string | null;
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
  if (immediateBridgeUrl) {
    onProgress?.("ready", "Sandbox ready!");
    return { bridgeUrl: immediateBridgeUrl, agentId };
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
        result?: { bridgeUrl?: string };
        error?: string;
      };
      status?: string;
      result?: { bridgeUrl?: string };
      error?: string;
    }>(`${resolvedCloudApiBase}/api/v1/jobs/${jobId}`, { headers });
    if (!jobRes.ok) continue;

    const jobData = jobRes.data;
    const status = jobData.data?.status ?? jobData.status;
    const result = jobData.data?.result ?? jobData.result;
    const error = jobData.data?.error ?? jobData.error;

    if (status === "completed" && result?.bridgeUrl) {
      onProgress?.("ready", "Sandbox ready!");
      return { bridgeUrl: result.bridgeUrl as string, agentId };
    }

    if (status === "failed") {
      throw new Error(`Provisioning failed: ${error ?? "Unknown error"}`);
    }

    onProgress?.("provisioning", `Status: ${status ?? "pending"}...`);
  }

  throw new Error("Provisioning timed out after 2 minutes");
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
