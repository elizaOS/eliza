/**
 * Steward Sidecar - health check polling.
 */
/**
 * Poll the steward /health endpoint until it returns { status: "ok" }
 * or the timeout is exceeded.
 */
export declare function waitForHealthy(
  apiBase: string,
  abort: AbortController,
): Promise<void>;
//# sourceMappingURL=health-check.d.ts.map
