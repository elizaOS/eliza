import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "@elizaos/plugin-elizacloud/cloud/base-url";
import { loadElizaConfig } from "@elizaos/agent/config/config";
import type {
  GetLifeOpsScheduleMergedStateResponse,
  SyncLifeOpsScheduleObservationsRequest,
  SyncLifeOpsScheduleObservationsResponse,
} from "./schedule-sync-contracts.js";

const LIFEOPS_SCHEDULE_REQUEST_TIMEOUT_MS = 20_000;

export class LifeOpsScheduleSyncClientError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LifeOpsScheduleSyncClientError";
  }
}

type ResolvedScheduleSyncConfig =
  | {
      configured: false;
      mode: "none";
    }
  | {
      configured: true;
      mode: "remote";
      baseUrl: string;
      accessToken: string | null;
    }
  | {
      configured: true;
      mode: "cloud";
      apiBaseUrl: string;
      apiKey: string;
      agentId: string;
    };

function normalizeSecret(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length === 0) {
    return null;
  }
  return trimmed.toUpperCase() === "[REDACTED]" ? null : trimmed;
}

function readCloudConfig(): {
  remoteApiBase: string | null;
  remoteAccessToken: string | null;
  apiKey: string | null;
  baseUrl: string | null;
  agentId: string | null;
} {
  try {
    const config = loadElizaConfig();
    const cloud =
      config.cloud && typeof config.cloud === "object"
        ? (config.cloud as Record<string, unknown>)
        : null;
    return {
      remoteApiBase:
        cloud && typeof cloud.remoteApiBase === "string"
          ? cloud.remoteApiBase.trim()
          : null,
      remoteAccessToken:
        cloud && typeof cloud.remoteAccessToken === "string"
          ? normalizeSecret(cloud.remoteAccessToken)
          : null,
      apiKey:
        cloud && typeof cloud.apiKey === "string"
          ? normalizeSecret(cloud.apiKey)
          : null,
      baseUrl:
        cloud && typeof cloud.baseUrl === "string"
          ? cloud.baseUrl.trim()
          : null,
      agentId:
        cloud && typeof cloud.agentId === "string"
          ? cloud.agentId.trim()
          : null,
    };
  } catch {
    return {
      remoteApiBase: null,
      remoteAccessToken: null,
      apiKey: null,
      baseUrl: null,
      agentId: null,
    };
  }
}

function resolveScheduleSyncConfig(): ResolvedScheduleSyncConfig {
  const config = readCloudConfig();
  if (config.remoteApiBase) {
    return {
      configured: true,
      mode: "remote",
      baseUrl: config.remoteApiBase.replace(/\/+$/, ""),
      accessToken:
        config.remoteAccessToken ??
        normalizeSecret(process.env.ELIZA_REMOTE_ACCESS_TOKEN),
    };
  }

  const apiKey =
    config.apiKey ?? normalizeSecret(process.env.ELIZAOS_CLOUD_API_KEY);
  const agentId =
    config.agentId ??
    normalizeSecret(process.env.ELIZAOS_CLOUD_AGENT_ID) ??
    null;
  if (!apiKey || !agentId) {
    return {
      configured: false,
      mode: "none",
    };
  }

  const baseUrl = config.baseUrl ?? process.env.ELIZAOS_CLOUD_BASE_URL;
  return {
    configured: true,
    mode: "cloud",
    apiBaseUrl: resolveCloudApiBaseUrl(baseUrl),
    apiKey,
    agentId,
  };
}

function buildTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(LIFEOPS_SCHEDULE_REQUEST_TIMEOUT_MS);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`.trim();
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed) as {
          error?: string;
          message?: string;
        };
        detail = parsed.message ?? parsed.error ?? trimmed;
      } catch {
        detail = trimmed.slice(0, 200);
      }
    }
    throw new LifeOpsScheduleSyncClientError(response.status, detail);
  }
  return (await response.json()) as T;
}

export function resolveLifeOpsScheduleSyncSiteUrl(rawUrl?: string): string {
  return normalizeCloudSiteUrl(rawUrl);
}

export class LifeOpsScheduleSyncClient {
  constructor(
    private readonly configSource:
      | ResolvedScheduleSyncConfig
      | (() => ResolvedScheduleSyncConfig) = resolveScheduleSyncConfig,
  ) {}

  private getConfig(): ResolvedScheduleSyncConfig {
    return typeof this.configSource === "function"
      ? this.configSource()
      : this.configSource;
  }

  get configured(): boolean {
    return this.getConfig().configured;
  }

  private requireConfig(): Exclude<
    ResolvedScheduleSyncConfig,
    { configured: false }
  > {
    const config = this.getConfig();
    if (!config.configured) {
      throw new LifeOpsScheduleSyncClientError(
        409,
        "LifeOps schedule sync is not configured.",
      );
    }
    return config;
  }

  private resolvePath(pathname: string): string {
    const config = this.requireConfig();
    const normalizedPath = pathname.replace(/^\/+/, "");
    if (config.mode === "remote") {
      return new URL(
        `api/lifeops/schedule/${normalizedPath}`,
        `${config.baseUrl.replace(/\/+$/, "")}/`,
      ).toString();
    }
    return new URL(
      `eliza/agents/${encodeURIComponent(config.agentId)}/lifeops/schedule/${normalizedPath}`,
      `${config.apiBaseUrl.replace(/\/+$/, "")}/`,
    ).toString();
  }

  private requestHeaders(
    initHeaders: HeadersInit | undefined,
  ): Record<string, string> {
    const config = this.requireConfig();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (config.mode === "cloud") {
      headers["X-API-Key"] = config.apiKey;
    }
    if (config.mode === "remote" && config.accessToken) {
      headers.Authorization = `Bearer ${config.accessToken}`;
    }
    if (initHeaders instanceof Headers) {
      for (const [key, value] of initHeaders.entries()) {
        headers[key] = value;
      }
      return headers;
    }
    if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) {
        headers[key] = value;
      }
      return headers;
    }
    return {
      ...headers,
      ...(initHeaders ?? {}),
    };
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await fetch(this.resolvePath(pathname), {
      ...init,
      headers: this.requestHeaders(init.headers),
      signal: init.signal ?? buildTimeoutSignal(),
    });
    return readJsonResponse<T>(response);
  }

  async syncObservations(
    request: SyncLifeOpsScheduleObservationsRequest,
  ): Promise<SyncLifeOpsScheduleObservationsResponse> {
    return this.request<SyncLifeOpsScheduleObservationsResponse>(
      "observations",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async getMergedState(
    timezone: string,
    scope: "local" | "cloud" | "effective" = "cloud",
  ): Promise<GetLifeOpsScheduleMergedStateResponse> {
    const query = new URLSearchParams({ timezone, scope });
    return this.request<GetLifeOpsScheduleMergedStateResponse>(
      `merged-state?${query.toString()}`,
      {
        method: "GET",
      },
    );
  }
}
