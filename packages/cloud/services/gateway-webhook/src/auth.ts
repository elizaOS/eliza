/** Handles webhook gateway authentication for authenticated connector fan-in. */
import { logger } from "./logger";

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_PERCENTAGE = 0.8;
const TOKEN_REFRESH_RETRY_MS = 1_000;
const MAX_GATEWAY_TOKEN_LIFETIME_SECONDS = 60;

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

interface AuthConfig {
  cloudUrl: string;
  bootstrapSecret: string;
  podName: string;
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid token response");
  }
  const candidate = value as Partial<TokenResponse>;
  if (
    typeof candidate.access_token !== "string" ||
    candidate.access_token.trim().length === 0 ||
    candidate.token_type !== "Bearer" ||
    typeof candidate.expires_in !== "number" ||
    !Number.isFinite(candidate.expires_in) ||
    candidate.expires_in <= 0 ||
    candidate.expires_in > MAX_GATEWAY_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("Invalid token response");
  }
  return candidate as TokenResponse;
}

let accessToken: string | null = null;
let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
let config: AuthConfig | null = null;
let authGeneration = 0;
let authStopped = true;

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = HTTP_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function acquireToken(): Promise<void> {
  const activeConfig = config;
  const generation = authGeneration;
  if (!activeConfig || authStopped) throw new Error("Auth not initialized");

  logger.info("Acquiring JWT token", { podName: activeConfig.podName });

  const response = await fetchWithTimeout(
    `${activeConfig.cloudUrl}/api/internal/auth/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Secret": activeConfig.bootstrapSecret,
      },
      body: JSON.stringify({
        pod_name: activeConfig.podName,
        service: "webhook-gateway",
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to acquire token: ${response.status} - ${error}`);
  }

  const data = parseTokenResponse(await response.json());
  if (authStopped || generation !== authGeneration || config !== activeConfig) {
    throw new Error("Token acquisition completed after authentication stopped");
  }
  accessToken = data.access_token;

  logger.info("JWT token acquired", {
    podName: activeConfig.podName,
    expiresIn: `${data.expires_in}s`,
  });

  scheduleRefresh(data.expires_in);
}

async function refreshToken(): Promise<void> {
  if (!config) throw new Error("Auth not initialized");
  await acquireToken();
}

function scheduleRefresh(expiresInSeconds: number): void {
  if (authStopped) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);

  const refreshInMs = expiresInSeconds * 1000 * TOKEN_REFRESH_PERCENTAGE;
  const timeout = setTimeout(() => {
    // error-policy:J1 The timer boundary converts renewal failure into a paced retry.
    refreshToken().catch((error) => {
      logger.error("Token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!authStopped && refreshTimeout === timeout) scheduleRefreshRetry();
    });
  }, refreshInMs);
  refreshTimeout = timeout;
}

function scheduleRefreshRetry(): void {
  if (authStopped) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);

  const timeout = setTimeout(() => {
    // error-policy:J1 The timer boundary retains the paced retry until recovery.
    refreshToken().catch((error) => {
      logger.error("Token refresh retry failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!authStopped && refreshTimeout === timeout) scheduleRefreshRetry();
    });
  }, TOKEN_REFRESH_RETRY_MS);
  refreshTimeout = timeout;
}

export async function initAuth(authConfig: AuthConfig): Promise<void> {
  authGeneration += 1;
  authStopped = false;
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;
  accessToken = null;
  config = authConfig;
  await acquireToken();
}

let reacquireInFlight: Promise<void> | null = null;

/**
 * Re-bootstraps the JWT and returns a fresh header. Single-flight: a Worker
 * redeploy invalidates the token for every in-flight message at once, and
 * without the latch each 401 would race its own bootstrap against the token
 * endpoint. Callers retry their request exactly once with the fresh header; a
 * second 401 follows the normal error path.
 */
export async function reacquireAuthHeader(): Promise<{
  Authorization: string;
}> {
  if (!reacquireInFlight) {
    const tracked = acquireToken().finally(() => {
      if (reacquireInFlight === tracked) reacquireInFlight = null;
    });
    reacquireInFlight = tracked;
  }
  await reacquireInFlight;
  return getAuthHeader();
}

export function getAuthHeader(): { Authorization: string } {
  if (!accessToken) {
    throw new Error("No access token available - call initAuth first");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

export function shutdownAuth(): void {
  authStopped = true;
  authGeneration += 1;
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  accessToken = null;
  config = null;
  reacquireInFlight = null;
}
