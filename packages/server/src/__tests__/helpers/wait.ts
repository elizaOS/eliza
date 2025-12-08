/**
 * Wait helpers for tests
 *
 * Provides smart waiting utilities with exponential backoff and timeouts.
 */

/**
 * Wait for a server to be ready by polling an endpoint
 *
 * @param port - Port number to check
 * @param timeout - Maximum time to wait in ms
 * @param endpoint - Endpoint to poll (default: /api/agents)
 * @returns Promise<void>
 * @throws Error if server is not ready within timeout
 *
 * @example
 * ```typescript
 * await waitForServerReady(5000, 10000);
 * console.log('Server is ready!');
 * ```
 */
export async function waitForServerReady(
  port: number,
  timeout = 10000,
  endpoint = '/api/agents'
): Promise<void> {
  const startTime = Date.now();
  const url = `http://localhost:${port}${endpoint}`;
  let lastError: Error | undefined;

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url);
      // Accept 200 OK or 404 Not Found (server is responding)
      if (response.ok || response.status === 404) {
        return;
      }
      lastError = new Error(`Server returned ${response.status}`);
    } catch (error) {
      lastError = error as Error;
    }

    // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
    const attempt = Math.floor((Date.now() - startTime) / 50);
    const backoff = Math.min(50 * Math.pow(2, attempt), 1000);
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }

  throw new Error(
    `Server not ready after ${timeout}ms (port ${port}). Last error: ${lastError?.message ?? 'unknown'}`
  );
}

/**
 * Wait for a condition to be true
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Configuration options
 * @returns Promise<void>
 * @throws Error if condition is not met within timeout
 *
 * @example
 * ```typescript
 * await waitFor(() => agent.isReady(), { timeout: 5000 });
 * ```
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Simple delay utility
 *
 * @param ms - Milliseconds to wait
 * @returns Promise<void>
 *
 * @example
 * ```typescript
 * await delay(1000); // Wait 1 second
 * ```
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
