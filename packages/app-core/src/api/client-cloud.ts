/**
 * Cloud domain methods — cloud billing, compat agents, sandbox,
 * export/import, direct cloud auth, bug reports.
 */

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

function isCloudRouteNotFound(error: unknown): error is ApiError {
  return (
    error instanceof Error &&
    "status" in error &&
    (error as ApiError).status === 404
  );
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
  return this.fetch("/api/cloud/status");
};

ElizaClient.prototype.getCloudCredits = async function (this: ElizaClient) {
  return this.fetch("/api/cloud/credits");
};

ElizaClient.prototype.getCloudBillingSummary = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/summary");
};

ElizaClient.prototype.getCloudBillingSettings = async function (
  this: ElizaClient,
) {
  return this.fetch("/api/cloud/billing/settings");
};

ElizaClient.prototype.updateCloudBillingSettings = async function (
  this: ElizaClient,
  request,
) {
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
  return this.fetch("/api/cloud/compat/agents");
};

ElizaClient.prototype.createCloudCompatAgent = async function (
  this: ElizaClient,
  opts,
) {
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
        redirectUrl: `/api/v1/milady/lifeops/github-complete?${params.toString()}`,
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
  const sessionId = globalThis.crypto.randomUUID();
  try {
    const res = await fetch(`${cloudApiBase}/api/auth/cli-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      return { ok: false, error: `Login failed (${res.status})` };
    }
    return {
      ok: true,
      sessionId,
      browserUrl: `${cloudApiBase}/auth/cli-login?session=${encodeURIComponent(sessionId)}`,
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
  try {
    const res = await fetch(
      `${cloudApiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
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

ElizaClient.prototype.provisionCloudSandbox = async function (
  this: ElizaClient,
  options,
) {
  const { cloudApiBase, authToken, name, bio, onProgress } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  onProgress?.("creating", "Creating agent...");

  // Step 1: Create agent
  const createRes = await fetch(`${cloudApiBase}/api/v1/app/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, bio }),
  });
  if (!createRes.ok) {
    const err = await createRes.text().catch(() => "Unknown error");
    throw new Error(`Failed to create cloud agent: ${err}`);
  }
  const createData = (await createRes.json()) as { id: string };
  const agentId = createData.id;

  onProgress?.("provisioning", "Provisioning sandbox environment...");

  // Step 2: Start provisioning
  const provisionRes = await fetch(
    `${cloudApiBase}/api/v1/app/agents/${agentId}/provision`,
    { method: "POST", headers },
  );
  if (!provisionRes.ok) {
    const err = await provisionRes.text().catch(() => "Unknown error");
    throw new Error(`Failed to start provisioning: ${err}`);
  }
  const provisionData = (await provisionRes.json()) as { jobId: string };
  const jobId = provisionData.jobId;

  // Step 3: Poll job status
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const jobRes = await fetch(`${cloudApiBase}/api/v1/jobs/${jobId}`, {
      headers,
    });
    if (!jobRes.ok) continue;

    const jobData = (await jobRes.json()) as {
      status: string;
      result?: { bridgeUrl?: string };
      error?: string;
    };

    if (jobData.status === "completed" && jobData.result?.bridgeUrl) {
      onProgress?.("ready", "Sandbox ready!");
      return { bridgeUrl: jobData.result.bridgeUrl, agentId };
    }

    if (jobData.status === "failed") {
      throw new Error(
        `Provisioning failed: ${jobData.error ?? "Unknown error"}`,
      );
    }

    onProgress?.("provisioning", `Status: ${jobData.status}...`);
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
