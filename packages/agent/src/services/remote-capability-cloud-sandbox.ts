import type { IAgentRuntime } from "@elizaos/core";
import {
  buildRemoteCapabilityEndpointTrustPolicy,
  connectRemoteCapabilityEndpointProvider,
  installRemoteCapabilityEndpoint,
  type ProvisionedRemoteCapabilityEndpoint,
  type RemoteCapabilityEndpointProvider,
  type RemoteCapabilityEndpointTrustPolicyOptions,
} from "./remote-capability-endpoint-provider.ts";
import type { RemoteCapabilityEndpointConfig } from "./remote-capability-router.ts";
import type { RemotePluginSyncResult } from "./remote-plugin-adapter.ts";

const DEFAULT_CLOUD_PROVISION_TIMEOUT_MS = 120_000;
const DEFAULT_CLOUD_PROVISION_POLL_MS = 2_000;

export type CloudCapabilitySandboxProvisionOptions = {
  cloudApiBase: string;
  authToken: string;
  name: string;
  bio?: string[];
  endpointId?: string;
  token?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetch?: typeof fetch;
  onProgress?: (status: string, detail?: string) => void;
  allowedModuleIds?: string[];
  trustPolicy?: RemoteCapabilityEndpointTrustPolicyOptions;
};

export type CloudCapabilitySandboxProvisionResult = {
  agentId: string;
  endpoint: RemoteCapabilityEndpointConfig;
  jobId?: string;
};

export type WaitForCloudCapabilityEndpointAvailabilityOptions = {
  endpoint: RemoteCapabilityEndpointConfig;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  onProgress?: (detail: string) => void;
};

export type ConnectCloudCapabilitySandboxOptions =
  CloudCapabilitySandboxProvisionOptions & {
    unloadMissing?: boolean;
    requestTimeoutMs?: number;
  };

export type ConnectCloudCapabilitySandboxResult =
  CloudCapabilitySandboxProvisionResult & {
    providerId: string;
    sync: RemotePluginSyncResult;
  };

export const cloudCapabilityEndpointProvider: RemoteCapabilityEndpointProvider<CloudCapabilitySandboxProvisionOptions> =
  {
    id: "cloud",
    provision: async (
      options,
    ): Promise<ProvisionedRemoteCapabilityEndpoint> => ({
      providerId: "cloud",
      ...(await provisionCloudCapabilitySandbox(options)),
      ...(options.allowedModuleIds === undefined
        ? {}
        : { allowedModuleIds: options.allowedModuleIds }),
      ...(options.trustPolicy === undefined
        ? {}
        : { trustPolicy: options.trustPolicy }),
    }),
  };

type CloudJsonResponse<T> = {
  ok: boolean;
  status: number;
  data?: T;
  text?: string;
};

type CreateAgentResponse = {
  data?: { id?: string };
  id?: string;
};

type ProvisionResponse = {
  data?: {
    jobId?: string;
    capabilityRouterUrl?: string | null;
    capability_router_url?: string | null;
    bridgeUrl?: string | null;
    bridge_url?: string | null;
    token?: string | null;
    capabilityRouterToken?: string | null;
    capability_router_token?: string | null;
  };
  jobId?: string;
  capabilityRouterUrl?: string | null;
  capability_router_url?: string | null;
  bridgeUrl?: string | null;
  bridge_url?: string | null;
  token?: string | null;
  capabilityRouterToken?: string | null;
  capability_router_token?: string | null;
};

type JobResponse = {
  data?: {
    status?: string;
    result?: ProvisionResponse["data"] | null;
    error?: string;
  };
  status?: string;
  result?: ProvisionResponse["data"] | null;
  error?: string;
};

export async function provisionCloudCapabilitySandbox(
  options: CloudCapabilitySandboxProvisionOptions,
): Promise<CloudCapabilitySandboxProvisionResult> {
  const request = options.fetch ?? fetch;
  const baseUrl = normalizeCloudApiBase(options.cloudApiBase);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.authToken}`,
  };

  options.onProgress?.("creating", "Creating cloud capability sandbox agent.");
  const create = await cloudJson<CreateAgentResponse>(
    request,
    `${baseUrl}/api/v1/eliza/agents`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentName: options.name,
        ...(options.bio?.length ? { agentConfig: { bio: options.bio } } : {}),
      }),
    },
  );
  if (!create.ok) {
    throw new Error(
      `Failed to create cloud capability sandbox: ${create.text ?? create.status}`,
    );
  }
  const agentId = create.data?.data?.id ?? create.data?.id;
  if (!agentId) {
    throw new Error(
      "Failed to create cloud capability sandbox: missing agent id.",
    );
  }

  options.onProgress?.(
    "provisioning",
    "Provisioning cloud capability endpoint.",
  );
  const provision = await cloudJson<ProvisionResponse>(
    request,
    `${baseUrl}/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    {
      method: "POST",
      headers,
    },
  );
  if (!provision.ok) {
    throw new Error(
      `Failed to provision cloud capability sandbox: ${
        provision.text ?? provision.status
      }`,
    );
  }

  const immediate = endpointFromProvisionPayload(options, provision.data);
  if (immediate) {
    options.onProgress?.("ready", "Cloud capability endpoint ready.");
    return { agentId, endpoint: immediate };
  }

  const jobId = provision.data?.data?.jobId ?? provision.data?.jobId;
  if (!jobId) {
    throw new Error(
      "Failed to provision cloud capability sandbox: missing job id and endpoint URL.",
    );
  }

  const deadline =
    Date.now() + (options.timeoutMs ?? DEFAULT_CLOUD_PROVISION_TIMEOUT_MS);
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_CLOUD_PROVISION_POLL_MS;
  let lastStatus: string | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const job = await cloudJson<JobResponse>(
      request,
      `${baseUrl}/api/v1/jobs/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
        headers,
      },
    );
    if (!job.ok) continue;
    const status = job.data?.data?.status ?? job.data?.status;
    const result = job.data?.data?.result ?? job.data?.result;
    const error = job.data?.data?.error ?? job.data?.error;
    lastStatus = status;
    lastError = error;
    const endpoint = endpointFromProvisionPayload(options, result);
    if (status === "completed" && endpoint) {
      options.onProgress?.("ready", "Cloud capability endpoint ready.");
      return { agentId, jobId, endpoint };
    }
    if (status === "failed") {
      throw new Error(
        `Cloud capability sandbox provisioning failed: ${error ?? "unknown error"}`,
      );
    }
    options.onProgress?.(
      "provisioning",
      `Cloud capability sandbox status: ${status ?? "pending"}.`,
    );
  }

  throw new Error(
    `Cloud capability sandbox provisioning timed out.${
      lastStatus ? ` Last status: ${lastStatus}.` : ""
    }${lastError ? ` Last error: ${lastError}.` : ""}`,
  );
}

export async function connectCloudCapabilitySandbox(
  runtime: IAgentRuntime,
  options: ConnectCloudCapabilitySandboxOptions,
): Promise<ConnectCloudCapabilitySandboxResult> {
  const result = await connectRemoteCapabilityEndpointProvider(runtime, {
    provider: cloudCapabilityEndpointProvider,
    provisionOptions: options,
    unloadMissing: options.unloadMissing,
    requestTimeoutMs: options.requestTimeoutMs,
    ...(options.allowedModuleIds === undefined
      ? {}
      : { allowedModuleIds: options.allowedModuleIds }),
    ...(options.trustPolicy === undefined
      ? {}
      : { trustPolicy: options.trustPolicy }),
  });
  assertCloudProvisionResult(result);
  return {
    agentId: result.agentId,
    providerId: result.providerId,
    endpoint: result.endpoint,
    ...(result.jobId === undefined ? {} : { jobId: result.jobId }),
    sync: result.sync,
  };
}

export async function waitForCloudCapabilityEndpointAvailability(
  options: WaitForCloudCapabilityEndpointAvailabilityOptions,
): Promise<void> {
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = "availability was not checked";

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await request(
          new URL("/v1/capabilities", options.endpoint.baseUrl),
          {
            method: "GET",
            headers: {
              accept: "application/json",
              ...(options.endpoint.token
                ? { authorization: `Bearer ${options.endpoint.token}` }
                : {}),
            },
            signal: controller.signal,
          },
        );
        const text = await response.text();
        if (!response.ok) {
          lastError = `HTTP ${response.status}: ${text.slice(0, 500)}`;
        } else {
          const availability = JSON.parse(text) as {
            available?: unknown;
            capabilities?: { plugin?: unknown };
          };
          if (
            availability.available === true &&
            availability.capabilities?.plugin === true
          ) {
            return;
          }
          lastError = `unexpected availability payload: ${text.slice(0, 500)}`;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    options.onProgress?.(
      `waiting for endpoint ${options.endpoint.id}: ${lastError}`,
    );
    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Cloud capability endpoint ${options.endpoint.id} did not report plugin availability within ${timeoutMs}ms. Last error: ${lastError}`,
  );
}

export {
  buildRemoteCapabilityEndpointTrustPolicy as buildEndpointTrustPolicy,
  installRemoteCapabilityEndpoint,
};

function assertCloudProvisionResult(
  result: ProvisionedRemoteCapabilityEndpoint,
): asserts result is ProvisionedRemoteCapabilityEndpoint & {
  agentId: string;
} {
  if (!result.agentId) {
    throw new Error(
      "Cloud capability sandbox provisioning returned no agent id.",
    );
  }
}

function endpointFromProvisionPayload(
  options: Pick<CloudCapabilitySandboxProvisionOptions, "endpointId" | "token">,
  payload: ProvisionResponse | ProvisionResponse["data"] | null | undefined,
): RemoteCapabilityEndpointConfig | null {
  const data =
    payload && "data" in payload && payload.data ? payload.data : payload;
  const baseUrl = firstString(
    data?.capabilityRouterUrl,
    data?.capability_router_url,
    data?.bridgeUrl,
    data?.bridge_url,
  );
  if (!baseUrl) return null;
  const token = firstString(
    options.token,
    data?.capabilityRouterToken,
    data?.capability_router_token,
    data?.token,
  );
  return {
    id: options.endpointId ?? "cloud-capability",
    baseUrl: stripTrailingSlash(baseUrl),
    ...(token === null ? {} : { token }),
  };
}

async function cloudJson<T>(
  request: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<CloudJsonResponse<T>> {
  const response = await request(url, {
    ...init,
    headers: lowercaseHeaders(init.headers),
  });
  const text = await response.text();
  let data: T | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      // keep raw text for errors
    }
  }
  return { ok: response.ok, status: response.status, data, text };
}

function lowercaseHeaders(headers: HeadersInit | undefined): HeadersInit {
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return headers ?? {};
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function normalizeCloudApiBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("cloudApiBase is required.");
  try {
    const url = new URL(trimmed);
    if (
      url.hostname === "www.elizacloud.ai" ||
      url.hostname === "elizacloud.ai"
    ) {
      url.hostname = "api.elizacloud.ai";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`Invalid cloudApiBase: ${value}`);
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
