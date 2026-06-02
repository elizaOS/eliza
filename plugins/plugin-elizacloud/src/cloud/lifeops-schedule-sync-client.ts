import {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "./base-url.js";
import type {
  GetLifeOpsScheduleMergedStateResponse,
  SyncLifeOpsScheduleObservationsRequest,
  SyncLifeOpsScheduleObservationsResponse,
} from "./lifeops-schedule-sync-contracts.js";

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

export type ResolvedLifeOpsScheduleSyncConfig =
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

export interface LifeOpsScheduleSyncConfigInput {
  remoteApiBase?: string | null;
  remoteAccessToken?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  agentId?: string | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function normalizeLifeOpsScheduleSyncSecret(
  value: string | null | undefined,
): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.toUpperCase() === "[REDACTED]" ? null : trimmed;
}

export function resolveLifeOpsScheduleSyncConfig(
  config: LifeOpsScheduleSyncConfigInput = {},
): ResolvedLifeOpsScheduleSyncConfig {
  const remoteApiBase = normalizeOptionalString(config.remoteApiBase);
  if (remoteApiBase) {
    return {
      configured: true,
      mode: "remote",
      baseUrl: remoteApiBase.replace(/\/+$/, ""),
      accessToken:
        normalizeLifeOpsScheduleSyncSecret(config.remoteAccessToken) ??
        normalizeLifeOpsScheduleSyncSecret(process.env.ELIZA_REMOTE_ACCESS_TOKEN),
    };
  }

  const apiKey =
    normalizeLifeOpsScheduleSyncSecret(config.apiKey) ??
    normalizeLifeOpsScheduleSyncSecret(process.env.ELIZAOS_CLOUD_API_KEY);
  const agentId =
    normalizeLifeOpsScheduleSyncSecret(config.agentId) ??
    normalizeLifeOpsScheduleSyncSecret(process.env.ELIZAOS_CLOUD_AGENT_ID);
  if (!apiKey || !agentId) {
    return {
      configured: false,
      mode: "none",
    };
  }

  return {
    configured: true,
    mode: "cloud",
    apiBaseUrl: resolveCloudApiBaseUrl(
      normalizeOptionalString(config.baseUrl) ?? process.env.ELIZAOS_CLOUD_BASE_URL,
    ),
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
      | ResolvedLifeOpsScheduleSyncConfig
      | (() => ResolvedLifeOpsScheduleSyncConfig) =
      resolveLifeOpsScheduleSyncConfig,
  ) {}

  private getConfig(): ResolvedLifeOpsScheduleSyncConfig {
    return typeof this.configSource === "function"
      ? this.configSource()
      : this.configSource;
  }

  get configured(): boolean {
    return this.getConfig().configured;
  }

  private requireConfig(): Exclude<
    ResolvedLifeOpsScheduleSyncConfig,
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
