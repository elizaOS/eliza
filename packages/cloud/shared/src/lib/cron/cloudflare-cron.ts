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
    // Keep the cache-only shared first-turn gates warm for recently active
    // agents (admission snapshot / pricing / character projection) so idle
    // cache expiry never bills a human's next message with the 503 warming
    // wall. Best-effort by the prewarm contract: latency-only, never an
    // authorization or billing outcome.
    "/api/v1/cron/shared-agent-keepwarm",
    "/api/cron/social-automation",
    "/api/cron/sample-eliza-price",
    "/api/cron/process-redemptions",
    "/api/cron/reconcile-domain-purchases",
    "/api/cron/cleanup-stuck-provisioning",
    // #14808 CLOUD lane: drain pending pii_scrub jobs (content-hash-idempotent,
    // budget-bounded; the scrub is background work, so 5-min cadence is plenty).
    "/api/cron/process-pii-scrub-jobs",
    // node-disk-maintenance matches the daemon's 5-min infra-maintenance cadence;
    // it's a daemon-superseded parity endpoint (the real prune runs in the
    // provisioning-worker, which owns the SSH credential + docker_nodes truth).
    "/api/v1/cron/node-disk-cleanup",
    // node-autoscale, agent-hot-pool, pool-drain-idle moved to the
    // provisioning-worker daemon's infra-maintenance cycle so the
    // orchestrator host owns docker_nodes truth. The control-plane still
    // serves these paths for compat but the CF cron no longer fans out
    // to it — see packages/cloud/scripts/admin/daemons/provisioning-worker.ts.
  ],
  "*/2 * * * *": ["/api/v1/cron/pool-health-check"],
  "*/10 * * * *": [
    "/api/cron/cleanup-expired-crypto-payments",
    "/api/cron/cleanup-expired-payment-requests",
    "/api/v1/cron/pool-image-rollout",
  ],
  "*/15 * * * *": [
    "/api/cron/auto-top-up",
    "/api/cron/agent-budgets",
    "/api/v1/cron/refresh-model-catalog",
    "/api/cron/domain-health",
  ],
  "* * * * *": [
    "/api/cron/shared-scheduled-tasks",
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
    // #22508: DELIBERATELY NOT SCHEDULED. The route 404s today because it is
    // GET-only, which has masked a defect: its second query filters on
    // user_identities.is_anonymous without joining user_identities, so
    // Postgres raises 42P01 — but only after an unbounded per-row DELETE
    // FROM users and a DELETE FROM anonymous_sessions have already
    // committed, with no enclosing transaction. Registering the POST verb
    // would turn a dormant broken job into a live destructive one. Fix the
    // query and bound the deletes before putting it back on a schedule.
    // #22508: the route existed and was mounted but was never in any schedule,
    // so expired CLI auth sessions accumulated forever.
    "/api/cron/cleanup-cli-sessions",
    "/api/v1/cron/agent-backups",
    // #9939: reap shared bridge rows leaked by a failed/timed-out handoff.
    "/api/v1/cron/reap-orphan-shared-bridges",
    // #16071: revoke stranded agent-sandbox keys left by a crash between the
    // tier-upgrade single-flight mint and the target-sandbox commit.
    "/api/cron/gc-stranded-sandbox-keys",
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
