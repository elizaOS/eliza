/**
 * Steward Sidecar - health check polling.
 */

import { sleep } from "./helpers";
import { HEALTH_CHECK_INTERVAL_MS, HEALTH_CHECK_TIMEOUT_MS } from "./types";

/**
 * Poll the steward /health endpoint until it returns { status: "ok" }
 * or the timeout is exceeded.
 */
export async function waitForHealthy(
  apiBase: string,
  abort: AbortController,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
    if (abort.signal.aborted) {
      throw new Error("Health check aborted");
    }

    try {
      const response = await fetch(`${apiBase}/health`, {
        signal: AbortSignal.timeout(2_000),
      });

      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "ok") {
          console.log(
            `[StewardSidecar] Healthy after ${Date.now() - startTime}ms`,
          );
          return;
        }
      }
    } catch {
      // Not ready yet
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  throw new Error(
    `Steward failed to become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
  );
}
