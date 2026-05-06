/**
 * Cron dispatcher for the Worker `scheduled()` handler.
 *
 * Schedules should stay in sync with `wrangler.toml`.
 */

import type { ExecutionContext as HonoExecutionContext } from "hono";
import { logger } from "@/lib/utils/logger";
import type { Bindings } from "@/types/cloud-worker-env";

/**
 * Legacy map: cron schedule → single URL path (prefer `CRON_FANOUT` for multiple paths).
 */
export const CRON_ROUTES: Record<string, string> = {
  "0 0 * * *": "/api/cron/container-billing",
  "0 * * * *": "/api/cron/agent-billing",
  "*/5 * * * *": "/api/cron/social-automation",
  "*/15 * * * *": "/api/cron/auto-top-up",
  "* * * * *": "/api/v1/cron/deployment-monitor",
};

/**
 * Each schedule may map to multiple paths; `scheduled()` fans out to all of them.
 */
export const CRON_FANOUT: Record<string, string[]> = {
  "0 0 * * *": ["/api/cron/container-billing", "/api/cron/release-pending-earnings"],
  "0 1 * * *": ["/api/cron/compute-metrics"],
  "0 2 * * *": ["/api/cron/cleanup-webhook-events"],
  "0 * * * *": ["/api/cron/agent-billing"],
  "*/5 * * * *": [
    "/api/cron/social-automation",
    "/api/cron/sample-eliza-price",
    "/api/cron/process-redemptions",
    "/api/cron/cleanup-stuck-provisioning",
    "/api/v1/cron/node-autoscale",
    "/api/v1/cron/agent-hot-pool",
  ],
  "*/10 * * * *": ["/api/cron/cleanup-expired-crypto-payments"],
  "*/15 * * * *": [
    "/api/cron/auto-top-up",
    "/api/cron/agent-budgets",
    "/api/v1/cron/refresh-model-catalog",
  ],
  "* * * * *": [
    "/api/v1/cron/deployment-monitor",
    "/api/v1/cron/health-check",
    "/api/v1/cron/process-provisioning-jobs",
    "/api/cron/process-stripe-queue",
  ],
  "0 */6 * * *": ["/api/cron/cleanup-anonymous-sessions"],
};

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

/**
 * Build the `scheduled()` handler bound to the same Hono app `fetch`.
 */
export function makeCronHandler(
  appFetch: (
    req: Request,
    env: Bindings,
    ctx: HonoExecutionContext,
  ) => Response | Promise<Response>,
) {
  return async function scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: HonoExecutionContext,
  ): Promise<void> {
    const paths = CRON_FANOUT[event.cron] ?? [];
    if (paths.length === 0) {
      logger.warn(`[Cron] No routes registered for schedule "${event.cron}"`);
      return;
    }
    const secret = env.CRON_SECRET ?? "";
    const baseUrl = env.NEXT_PUBLIC_APP_URL ?? "http://internal";

    const work = paths.map(async (path) => {
      try {
        const req = new Request(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "x-cron-secret": secret, "user-agent": "cf-cron/1.0" },
        });
        const res = await appFetch(req, env, ctx);
        if (!res.ok) {
          logger.warn(`[Cron] ${path} -> ${res.status}`);
        }
      } catch (err) {
        logger.error(`[Cron] ${path} threw`, { error: err });
      }
    });
    ctx.waitUntil(Promise.all(work).then(() => undefined));
  };
}
