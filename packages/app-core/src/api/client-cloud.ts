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
  type?: string;
  status?: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  attempts?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
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
  const token =
    client.getRestAuthToken() ??
    ((globalThis as Record<string, unknown>)
      .__ELIZA_CLOUD_AUTH_TOKEN__ as unknown);
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function parseDirectCloudJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  if (!data.trim()) return {};
  return JSON.parse(data);
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
    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
      responseType: "json",
      connectTimeout: 10_000,
      readTimeout: 10_000,
    });
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error(`Cloud request failed (${res.status})`), {
        status: res.status,
        data: res.data,
        url,
      });
    }
    return parseDirectCloudJson(res.data) as T;
  }

  const res = await fetch(url, { ...init, method, headers });
  const data = await res.json().catch(async () => ({
    error: await res.text().catch(() => res.statusText),
  }));
  if (!res.ok) {
    throw Object.assign(new Error(`Cloud request failed (${res.status})`), {
      status: res.status,
      data,
      url,
    });
  }
  return data as T;
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

function toCloudCompatJob(input: DirectCloudJob): CloudCompatJob {
  const status: CloudCompatJob["status"] = (() => {
    switch (input.status) {
      case "completed":
      case "failed":
      case "retrying":
        return input.status;
      case "in_progress":
      case "processing":
        return "processing";
      default:
        return "queued";
    }
  })();
  const id = stringOrNull(input.id) ?? "";
  const createdAt = stringOrNull(input.createdAt) ?? new Date(0).toISOString();
  const completedAt = input.completedAt ?? null;

  return {
    jobId: id,
    type: stringOrNull(input.type) ?? "agent_provision",
    status,
    data: {},
    result: input.result ?? null,
    error: input.error ?? null,
    createdAt,
    startedAt: input.startedAt ?? null,
    completedAt,
    retryCount: input.attempts ?? 0,
    id,
    name: stringOrNull(input.type) ?? "agent_provision",
    state: status,
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
      data: CloudCompatLaunchResult;
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
  if (isDirectCloudBase(this)) {
    return this.fetch(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
      { method: "POST" },
      { allowNonOk: true },
    );
  }

  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
    { allowNonOk: true },
  );
};

ElizaClient.prototype.getCloudCompatAgent = async function (
  this: ElizaClient,
  agentId,
) {
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
  return this.fetch(`/api/cloud/compat/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
};

ElizaClient.prototype.getCloudCompatAgentStatus = async function (
  this: ElizaClient,
  agentId,
) {
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
  return this.fetch(
    `/api/cloud/compat/agents/${encodeURIComponent(agentId)}/launch`,
    { method: "POST" },
  );
};

ElizaClient.prototype.getCloudCompatPairingToken = async function (
  this: ElizaClient,
  agentId,
) {
  return this.fetch(
    `/api/cloud/v1/app/agents/${encodeURIComponent(agentId)}/pairing-token`,
    { method: "POST" },
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
  const createRes = await fetch(`${resolvedCloudApiBase}/api/v1/eliza/agents`, {
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
    const err = await createRes.text().catch(() => "Unknown error");
    throw new Error(`Failed to create cloud agent: ${err}`);
  }
  const createData = (await createRes.json()) as {
    data?: { id?: string };
    id?: string;
  };
  const agentId = createData.data?.id ?? createData.id;
  if (!agentId) {
    throw new Error("Failed to create cloud agent: missing agent id");
  }

  onProgress?.("provisioning", "Provisioning sandbox environment...");

  // Step 2: Start provisioning
  const provisionRes = await fetch(
    `${resolvedCloudApiBase}/api/v1/eliza/agents/${agentId}/provision`,
    { method: "POST", headers },
  );
  if (!provisionRes.ok) {
    const err = await provisionRes.text().catch(() => "Unknown error");
    throw new Error(`Failed to start provisioning: ${err}`);
  }
  const provisionData = (await provisionRes.json()) as {
    data?: {
      jobId?: string;
      bridgeUrl?: string | null;
    };
    jobId?: string;
    bridgeUrl?: string | null;
  };
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

    const jobRes = await fetch(`${resolvedCloudApiBase}/api/v1/jobs/${jobId}`, {
      headers,
    });
    if (!jobRes.ok) continue;

    const jobData = (await jobRes.json()) as {
      data?: {
        status?: string;
        result?: { bridgeUrl?: string };
        error?: string;
      };
      status?: string;
      result?: { bridgeUrl?: string };
      error?: string;
    };
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
