import { logger } from "./logger";

const HTTP_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_PERCENTAGE = 0.8;

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

  logger.info("Acquiring JWT token", { podName: config.podName });

  const response = await fetchWithTimeout(`${config.cloudUrl}/api/internal/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gateway-Secret": config.bootstrapSecret,
    },
    body: JSON.stringify({
      pod_name: config.podName,
      service: "webhook-gateway",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to acquire token: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as TokenResponse;
  accessToken = data.access_token;

  logger.info("JWT token acquired", {
    podName: config.podName,
    expiresIn: `${data.expires_in}s`,
  });

  scheduleRefresh(data.expires_in);
}

async function refreshToken(): Promise<void> {
  if (!config) throw new Error("Auth not initialized");

  if (!accessToken) {
    await acquireToken();
    return;
  }

  logger.info("Refreshing JWT token", { podName: config.podName });

  try {
    const response = await fetchWithTimeout(`${config.cloudUrl}/api/internal/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      logger.warn("Token refresh failed, acquiring new token", {
        status: response.status,
      });
      await acquireToken();
      return;
    }

    const data = (await response.json()) as TokenResponse;
    accessToken = data.access_token;

    logger.info("JWT token refreshed", {
      podName: config.podName,
      expiresIn: `${data.expires_in}s`,
    });

    scheduleRefresh(data.expires_in);
  } catch (error) {
    logger.error("Error refreshing token, attempting re-acquisition", {
      error: error instanceof Error ? error.message : String(error),
    });
    await acquireToken();
  }
}

function scheduleRefresh(expiresInSeconds: number): void {
  if (refreshTimeout) clearTimeout(refreshTimeout);

  const refreshInMs = expiresInSeconds * 1000 * TOKEN_REFRESH_PERCENTAGE;
  refreshTimeout = setTimeout(() => {
    refreshToken().catch((error) => {
      logger.error("Token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, refreshInMs);
}

export async function initAuth(authConfig: AuthConfig): Promise<void> {
  config = authConfig;
  await acquireToken();
}

export function getAuthHeader(): { Authorization: string } {
  if (!accessToken) {
    throw new Error("No access token available - call initAuth first");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

export function shutdownAuth(): void {
  if (refreshTimeout) {
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  }
  accessToken = null;
  config = null;
}
