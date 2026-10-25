// Shared by the restart, resume, and suspend service routes.

import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";

/**
 * Keeps a provisioning-worker nudge alive after the response: a Worker can
 * cancel an unregistered promise when the response ends.
 */
export function registerNudge(c: AppContext, nudge: Promise<unknown>): void {
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx?.waitUntil?.bind(c.executionCtx);
  } catch {
    // error-policy:J4 Hono local/test contexts have no ExecutionContext; the
    // queued job stays visible to the polling worker.
    waitUntil = undefined;
  }
  if (waitUntil) waitUntil(nudge);
  else void nudge;
}
