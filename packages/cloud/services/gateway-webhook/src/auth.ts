/** Handles webhook gateway authentication for authenticated connector fan-in. */
import { logger } from "./logger";

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_PERCENTAGE = 0.8;
const TOKEN_REFRESH_RETRY_MIN_MS = 1_000;
const TOKEN_REFRESH_RETRY_MAX_MS = 30_000;

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

let accessToken: string | null = null;
let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
let config: AuthConfig | null = null;
let refreshRetryAttempt = 0;
let authLifecycleGeneration = 0;

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
  if (!config) throw new Error("Auth not initialized");
  const lifecycleGeneration = authLifecycleGeneration;
  const activeConfig = config;

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

  const data = (await response.json()) as TokenResponse;
  if (lifecycleGeneration !== authLifecycleGeneration) {
    throw new Error("Auth lifecycle changed during token acquisition");
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
  if (refreshTimeout) clearTimeout(refreshTimeout);

  const refreshInMs = expiresInSeconds * 1000 * TOKEN_REFRESH_PERCENTAGE;
  refreshRetryAttempt = 0;
  const timeout = setTimeout(() => {
    // error-policy:J1 The timer boundary converts renewal failure into a paced retry.
    refreshToken().catch((error) => {
      logger.error("Token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (refreshTimeout === timeout) scheduleRefreshRetry();
    });
  }, refreshInMs);
  refreshTimeout = timeout;
}

function scheduleRefreshRetry(): void {
  if (refreshTimeout) clearTimeout(refreshTimeout);

  const retryInMs = Math.min(
    TOKEN_REFRESH_RETRY_MIN_MS * 2 ** refreshRetryAttempt,
    TOKEN_REFRESH_RETRY_MAX_MS,
  );
  refreshRetryAttempt = Math.min(refreshRetryAttempt + 1, 5);
  const lifecycleGeneration = authLifecycleGeneration;
  const timeout = setTimeout(() => {
    if (lifecycleGeneration !== authLifecycleGeneration) return;
    // error-policy:J1 The timer boundary retains the paced retry until recovery.
    refreshToken().catch((error) => {
      logger.error("Token refresh retry failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (refreshTimeout === timeout) scheduleRefreshRetry();
    });
  }, retryInMs);
  refreshTimeout = timeout;

  logger.debug("Token refresh retry scheduled", {
    retryInMs,
    retryAttempt: refreshRetryAttempt,
  });
}

export async function initAuth(authConfig: AuthConfig): Promise<void> {
  authLifecycleGeneration += 1;
  config = authConfig;
  await acquireToken();
}

let reacquireInFlight: { generation: number; promise: Promise<void> } | null =
  null;

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
  const generation = authLifecycleGeneration;
  if (!reacquireInFlight || reacquireInFlight.generation !== generation) {
    const promise = acquireToken().finally(() => {
      if (reacquireInFlight?.promise === promise) {
        reacquireInFlight = null;
      }
    });
    reacquireInFlight = { generation, promise };
  }
  await reacquireInFlight.promise;
  if (generation !== authLifecycleGeneration) {
    throw new Error("Auth lifecycle changed during token acquisition");
  }
  return getAuthHeader();
}

export function getAuthHeader(): { Authorization: string } {
  if (!accessToken) {
    throw new Error("No access token available - call initAuth first");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

export function shutdownAuth(): void {
  authLifecycleGeneration += 1;
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  accessToken = null;
  config = null;
  refreshRetryAttempt = 0;
}
