import type { IAgentRuntime } from "@elizaos/core";

const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_API_BASE_PROD = "https://staging.feed.market";
const DEFAULT_API_BASE_DEV = "http://localhost:3000";
const FEED_AGENT_SESSION_TOKEN_KEY = "FEED_AGENT_SESSION_TOKEN";
const FEED_AGENT_SESSION_EXPIRES_AT_KEY = "FEED_AGENT_SESSION_EXPIRES_AT";

interface FeedAuthToken {
  token: string;
  expiresAt: number;
}

let cachedToken: FeedAuthToken | null = null;

interface RuntimeLike {
  agentId?: string;
  character?: {
    name?: string;
    settings?: { secrets?: Record<string, string> };
    secrets?: Record<string, string>;
  };
  getSetting?: (key: string) => string | null | undefined;
  setSetting?: (key: string, value: string, secret?: boolean) => void;
}

export function asRuntimeLike(value: unknown): RuntimeLike | null {
  return value && typeof value === "object" ? (value as RuntimeLike) : null;
}

export function resolveSettingLike(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtime?.getSetting?.(key);
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime.trim();
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return undefined;
}

export interface FeedConfig {
  apiBaseUrl: string;
  agentId: string | undefined;
  agentSecret: string | undefined;
  /**
   * The agent's existing Steward/Eliza-Cloud session JWT. When present, the
   * agent auto-logs in to Feed with this token (Feed verifies the shared-secret
   * HS256 `iss:"steward"` JWT inline) — no `FEED_AGENT_ID`/`FEED_AGENT_SECRET`
   * exchange is required. Resolved from the agent's Steward sidecar credential.
   */
  stewardToken: string | undefined;
  runtime: IAgentRuntime | null;
}

/**
 * Resolve the agent's Steward session JWT from the runtime/env. The app-core
 * Steward sidecar persists the agent token to `STEWARD_AGENT_TOKEN`;
 * `FEED_STEWARD_TOKEN` is an explicit per-app override.
 */
export function resolveStewardToken(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
): string | undefined {
  return (
    resolveSettingLike(runtime, "FEED_STEWARD_TOKEN") ??
    resolveSettingLike(runtime, "STEWARD_AGENT_TOKEN")
  );
}

export function resolveFeedConfig(runtime: IAgentRuntime | null): FeedConfig {
  return {
    apiBaseUrl: (
      resolveSettingLike(runtime, "FEED_API_URL") ??
      resolveSettingLike(runtime, "FEED_APP_URL") ??
      resolveSettingLike(runtime, "FEED_CLIENT_URL") ??
      (process.env.NODE_ENV === "production"
        ? DEFAULT_API_BASE_PROD
        : DEFAULT_API_BASE_DEV)
    ).replace(/\/+$/, ""),
    agentId: resolveSettingLike(runtime, "FEED_AGENT_ID"),
    agentSecret: resolveSettingLike(runtime, "FEED_AGENT_SECRET"),
    stewardToken: resolveStewardToken(runtime),
    runtime,
  };
}

export function resolveFeedClientUrl(
  runtime: IAgentRuntime | RuntimeLike | null | undefined,
): string {
  return (
    resolveSettingLike(runtime, "FEED_CLIENT_URL") ??
    resolveSettingLike(runtime, "FEED_APP_URL") ??
    resolveSettingLike(runtime, "FEED_API_URL") ??
    (process.env.NODE_ENV === "production"
      ? DEFAULT_API_BASE_PROD
      : DEFAULT_API_BASE_DEV)
  ).replace(/\/+$/, "");
}

export function persistFeedCredential(
  runtime: IAgentRuntime | RuntimeLike | null,
  key: string,
  value: string,
  secret = false,
): void {
  process.env[key] = value;
  runtime?.setSetting?.(key, value, secret);

  const runtimeLike = asRuntimeLike(runtime);
  const character = runtimeLike?.character;
  if (!character) return;
  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;
  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

async function authenticate(config: FeedConfig): Promise<string> {
  if (!config.agentId || !config.agentSecret) {
    throw new Error(
      "Feed agent credentials not configured. Set FEED_AGENT_ID and FEED_AGENT_SECRET.",
    );
  }

  const url = new URL("/api/agents/auth", config.apiBaseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: config.agentId,
      agentSecret: config.agentSecret,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Feed auth failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    token?: string;
    sessionToken?: string;
    expiresIn?: number;
  };
  const token = data.token ?? data.sessionToken;
  if (!token) {
    throw new Error("Feed auth response did not include a session token.");
  }

  const expiresIn = data.expiresIn ?? 14 * 60;
  cachedToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  persistFeedCredential(
    config.runtime,
    FEED_AGENT_SESSION_TOKEN_KEY,
    token,
    true,
  );
  persistFeedCredential(
    config.runtime,
    FEED_AGENT_SESSION_EXPIRES_AT_KEY,
    String(cachedToken.expiresAt),
    true,
  );

  return token;
}

async function getSessionToken(config: FeedConfig): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }

  if (!config.agentId || !config.agentSecret) {
    return null;
  }

  return authenticate(config);
}

function clearCachedToken(): void {
  cachedToken = null;
}

export async function proxyFeedRequest(
  config: FeedConfig,
  method: string,
  apiPath: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(apiPath, config.apiBaseUrl);
  const apiKey = resolveSettingLike(config.runtime, "FEED_A2A_API_KEY");

  const send = (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (apiKey) {
      headers["X-Feed-Api-Key"] = apiKey;
    }
    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  };

  // Prefer the agent's existing Steward/Eliza-Cloud session JWT. Feed verifies
  // it inline (shared-secret HS256, iss:"steward"), so the agent auto-logs in
  // without the FEED_AGENT_ID/SECRET → /api/agents/auth exchange. On rejection
  // (expired token / unshared secret) we fall through to the agent-session path.
  if (config.stewardToken) {
    const stewardResponse = await send(config.stewardToken);
    if (stewardResponse.status !== 401) {
      return stewardResponse;
    }
  }

  const token = await getSessionToken(config);
  const response = await send(token);

  if (response.status === 401 && token) {
    clearCachedToken();
    const newToken = await getSessionToken(config);
    if (newToken && newToken !== token) {
      return send(newToken);
    }
  }

  return response;
}
