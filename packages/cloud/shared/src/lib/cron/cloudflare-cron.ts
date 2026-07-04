/**
 * Cron dispatcher for the Worker `scheduled()` handler.
 *
 * Schedules should stay in sync with `wrangler.toml`.
 */

import type { ExecutionContext as HonoExecutionContext } from "hono";
import type { Bindings } from "../../types/cloud-worker-env";
import { logger } from "../utils/logger";

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
  "0 0 * * *": ["/api/cron/container-billing"],
  "0 1 * * *": ["/api/cron/compute-metrics"],
  "0 2 * * *": ["/api/cron/cleanup-webhook-events"],
  "0 3 * * *": [
    "/api/cron/domain-renewals",
    // #11058: release external domain rows still unverified after the reclaim
    // TTL (48h default, MANAGED_DOMAIN_UNVERIFIED_TTL_MS override).
    "/api/cron/reclaim-stale-domains",
  ],
  "0 * * * *": ["/api/cron/agent-billing"],
  "*/5 * * * *": [
    "/api/cron/social-automation",
    "/api/cron/sample-eliza-price",
    "/api/cron/process-redemptions",
    "/api/cron/cleanup-stuck-provisioning",
    // node-disk-cleanup matches the daemon's 5-min infra-maintenance cadence;
    // it's a daemon-superseded parity endpoint (the real prune runs in the
    // provisioning-worker, which owns the SSH credential + docker_nodes truth).
    "/api/v1/cron/node-disk-cleanup",
    // node-autoscale, agent-hot-pool, pool-drain-idle moved to the
    // provisioning-worker daemon's infra-maintenance cycle so the
    // orchestrator host owns docker_nodes truth. The control-plane still
    // serves these paths for compat but the CF cron no longer fans out
    // to it — see packages/scripts/cloud/admin/daemons/provisioning-worker.ts.
  ],
  "*/2 * * * *": ["/api/v1/cron/pool-health-check"],
  "*/10 * * * *": ["/api/cron/cleanup-expired-crypto-payments", "/api/v1/cron/pool-image-rollout"],
  "*/15 * * * *": [
    "/api/cron/auto-top-up",
    "/api/cron/agent-budgets",
    "/api/v1/cron/refresh-model-catalog",
    "/api/cron/domain-health",
  ],
  "* * * * *": [
    "/api/v1/cron/deployment-monitor",
    "/api/v1/cron/health-check",
    // Alerts ops when the provisioning-worker daemon's heartbeat goes
    // stale/absent — the daemon can't page about its own death, so this
    // runs separately on the Worker (#9853).
    "/api/v1/cron/provisioning-worker-health",
    "/api/v1/cron/process-provisioning-jobs",
    "/api/cron/process-stripe-queue",
    "/api/v1/cron/pool-replenish",
    // #9899 Tier-2 optimistic-billing backstop (no-op when the flag is off).
    "/api/cron/sweep-inference-charges",
    // #11169 synchronous-reservation backstop for dropped waitUntil settles.
    "/api/cron/sweep-credit-reservations",
    // #11862: settle poll-timeout video holds against the upstream terminal
    // state — charge on late success, refund once on verified failure.
    "/api/cron/reconcile-video-generations",
  ],
  "0 */6 * * *": [
    "/api/cron/cleanup-anonymous-sessions",
    "/api/v1/cron/agent-backups",
    // #9939: reap shared bridge rows leaked by a failed/timed-out handoff.
    "/api/v1/cron/reap-orphan-shared-bridges",
  ],
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
