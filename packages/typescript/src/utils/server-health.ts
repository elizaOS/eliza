/**
 * Server health check utilities for waiting for servers to be ready
 */

export interface ServerHealthOptions {
  port: number;
  endpoint?: string;
  maxWaitTime?: number;
  pollInterval?: number;
  requestTimeout?: number;
  host?: string;
  protocol?: "http" | "https";
}

/**
 * Error thrown when server fails to become ready within the timeout
 */
export class ServerHealthError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "ServerHealthError";
  }
}

/**
 * Build URL from options
 */
function buildUrl(options: ServerHealthOptions): string {
  const {
    port,
    endpoint = "/api/agents",
    host = "localhost",
    protocol = "http",
  } = options;
  return `${protocol}://${host}:${port}${endpoint}`;
}

/**
 * Perform a single health check request with timeout
 */
async function checkHealth(
  url: string,
  timeout: number,
): Promise<{ ok: boolean; error?: Error }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return { ok: response.ok };
  } catch (error) {
    // Network errors, timeouts, aborts are expected during startup
    return { ok: false, error: error as Error };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Wait for server to be ready by polling health endpoint
 *
 * @param options - Configuration options for server health check
 * @throws ServerHealthError if server doesn't become ready within maxWaitTime
 */
export async function waitForServerReady(
  options: ServerHealthOptions,
): Promise<void> {
  const {
    maxWaitTime = 30000,
    pollInterval = 1000,
    requestTimeout = 2000,
  } = options;

  const url = buildUrl(options);
  const startTime = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startTime < maxWaitTime) {
    const result = await checkHealth(url, requestTimeout);

    if (result.ok) {
      // Server is ready, give it one more second to stabilize
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return;
    }

    lastError = result.error;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new ServerHealthError(
    `Server failed to become ready at ${url} within ${maxWaitTime}ms`,
    url,
    lastError,
  );
}

/**
 * Simple ping check for server availability (no stabilization wait)
 *
 * @param options - Configuration options for server ping
 * @returns true if server responds with 2xx, false otherwise
 */
export async function pingServer(
  options: ServerHealthOptions,
): Promise<boolean> {
  const { requestTimeout = 2000 } = options;
  const url = buildUrl(options);
  const result = await checkHealth(url, requestTimeout);
  return result.ok;
}
