/**
 * Steward Sidecar - health check polling.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "@elizaos/core";
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
    abort.signal.throwIfAborted();

    try {
      const response = await fetch(`${apiBase}/health`, {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]),
      });

      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === "ok") {
          logger.info(
            `[StewardSidecar] Healthy after ${Date.now() - startTime}ms`,
          );
          return;
        }
      }
    } catch {
      abort.signal.throwIfAborted();
      // A failed probe may recover before the overall readiness deadline.
    }

    await sleep(HEALTH_CHECK_INTERVAL_MS, undefined, { signal: abort.signal });
  }

  throw new Error(
    `Steward failed to become healthy within ${HEALTH_CHECK_TIMEOUT_MS}ms`,
  );
}
