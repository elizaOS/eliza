/**
 * Provisioning-worker health MONITOR (alerting layer).
 *
 * `provisioning-worker-health.ts` is the *gate*: the cloud-api Worker reads the
 * daemon's Redis heartbeat on every provision/wake/resume request and fails
 * CLOSED when it's stale. That protects correctness but is silent — a wedged
 * daemon just turns every provision into a 503 with nobody paged, while
 * container-stop billing cleanup and per-tenant DB isolation (both daemon jobs)
 * quietly stop running.
 *
 * This module closes that gap: it observes the heartbeat and, when it is
 * stale/absent, makes it LOUD (structured error log + the configured ops alert
 * channels) and returns a queryable status the platform can gate on. Intended
 * to be invoked on a schedule (separate from the daemon, which cannot alert
 * about its own death) — wiring that schedule is infra, not this module.
 */

import { logger } from "../utils/logger";
import { writeCloudApiDbHeartbeat } from "./cloud-api-db-heartbeat";
import {
  checkProvisioningWorkerHealth,
  PROVISIONING_WORKER_HEARTBEAT_TTL_S,
  type ProvisioningWorkerHealth,
} from "./provisioning-worker-health";

/**
 * Alert-channel env vars, mirroring the per-domain convention already used by
 * `payout-alerts` (`REDEMPTION_ALERT_*`) and the social-media alerts
 * (`SOCIAL_ALERTS_*`). Both optional: the structured error log always fires so
 * the alert is never fully silent even with no channel configured.
 */
const ALERT_SLACK_WEBHOOK_ENV = "PROVISIONING_ALERT_SLACK_WEBHOOK";
const ALERT_PAGERDUTY_KEY_ENV = "PROVISIONING_ALERT_PAGERDUTY_KEY";

/**
 * A heartbeat older than this is treated as stale even if the Redis key still
 * exists. The gate relies on Redis TTL alone (key present == fresh); this
 * age check is defense-in-depth against a misconfigured/over-long TTL or a
 * clock-skewed daemon. Reuses the daemon's own TTL so the monitor and the
 * gate agree on "fresh".
 */
export const HEARTBEAT_MAX_AGE_MS = PROVISIONING_WORKER_HEARTBEAT_TTL_S * 1000;

/**
 * Ops alert payload for daemon-domain failures. Also emitted by the backup
 * restorability verifier (`agent-backup-verifier.ts`), which shares this
 * module's alert channels; `dedupKey` keeps each failure domain a separate
 * PagerDuty incident instead of collapsing into the heartbeat one.
 */
export interface DaemonHealthAlert {
  title: string;
  message: string;
  details: Record<string, unknown>;
  /** PagerDuty dedup key. Defaults to the daemon-heartbeat incident key. */
  dedupKey?: string;
}

/**
 * True when the heartbeat is absent, unparseable, or older than `maxAgeMs`.
 * Pure logic, unit-tested in isolation.
 */
export function isHeartbeatStale(
  lastHeartbeatAt: string | undefined,
  nowMs: number,
  maxAgeMs: number = HEARTBEAT_MAX_AGE_MS,
): boolean {
  if (!lastHeartbeatAt) return true;
  const heartbeatMs = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(heartbeatMs)) return true;
  return nowMs - heartbeatMs > maxAgeMs;
}

/**
 * Emit a daemon-health alert. Always logs a structured error (loud even with
 * no channel configured), then fans out to whatever ops channels are wired.
 * PagerDuty uses a fixed dedup key so a sustained outage is ONE incident, not
 * one per monitor tick.
 */
export async function sendProvisioningWorkerAlert(alert: DaemonHealthAlert): Promise<void> {
  logger.error(`[ProvisioningWorkerHealth] ${alert.title}`, {
    message: alert.message,
    ...alert.details,
  });

  const slackWebhook = process.env[ALERT_SLACK_WEBHOOK_ENV];
  const pagerDutyKey = process.env[ALERT_PAGERDUTY_KEY_ENV];

  const sends: Promise<unknown>[] = [];

  if (slackWebhook) {
    sends.push(
      fetch(slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `🚨 *[elizaOS Provisioning]* ${alert.title}\n${alert.message}`,
        }),
      }),
    );
  }

  if (pagerDutyKey) {
    sends.push(
      fetch("https://events.pagerduty.com/v2/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routing_key: pagerDutyKey,
          event_action: "trigger",
          dedup_key: alert.dedupKey ?? "provisioning-worker-unhealthy",
          payload: {
            summary: `[elizaOS Provisioning] ${alert.title}`,
            severity: "critical",
            source: "eliza-cloud-provisioning-worker",
            custom_details: { message: alert.message, ...alert.details },
          },
        }),
      }),
    );
  }

  const results = await Promise.allSettled(sends);
  const failures = results.filter((r) => r.status === "rejected").length;
  if (failures > 0) {
    logger.error(`[ProvisioningWorkerHealth] ${failures}/${results.length} alert channels failed`);
  }
}

/**
 * Observe the provisioning-worker heartbeat and alert when it is unhealthy.
 *
 * Healthy iff the daemon is not required, or the heartbeat is present AND
 * fresh. An absent heartbeat (gate already 503s) or a present-but-stale one
 * both fire an alert. Returns the underlying gate health plus a `stale` flag
 * so callers can expose/gate on a queryable status without re-deriving it.
 *
 * `check`/`alert`/`now` are injectable for tests; production uses the real
 * Redis-backed gate, the ops alert channels, and the wall clock.
 */
export async function monitorProvisioningWorkerHealth(
  deps: {
    check?: () => Promise<ProvisioningWorkerHealth>;
    alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
    now?: () => number;
    writeDbHeartbeat?: () => Promise<void>;
  } = {},
): Promise<{ healthy: boolean; stale: boolean; health: ProvisioningWorkerHealth }> {
  const check = deps.check ?? checkProvisioningWorkerHealth;
  const alert = deps.alert ?? sendProvisioningWorkerAlert;
  const nowMs = (deps.now ?? Date.now)();

  // #16160: this cron fires every minute regardless of provisioning traffic —
  // stamp the shared-DB heartbeat the daemon's DB-liveness check reads to tell
  // an idle env apart from a DB split. Never throws (logged inside).
  await (deps.writeDbHeartbeat ?? writeCloudApiDbHeartbeat)();

  const health = await check();

  if (!health.required) {
    return { healthy: true, stale: false, health };
  }

  const stale = health.ok && isHeartbeatStale(health.lastHeartbeatAt, nowMs);
  const healthy = health.ok && !stale;

  if (!healthy) {
    await alert({
      title: "Provisioning worker is unhealthy",
      message:
        `${health.ok ? `Heartbeat is stale (last seen ${health.lastHeartbeatAt ?? "never"}).` : health.error} ` +
        "Container-stop billing cleanup and per-tenant DB isolation depend on this daemon; " +
        "provisioning is failing closed until it recovers.",
      details: {
        code: health.ok ? "PROVISIONING_WORKER_STALE_HEARTBEAT" : health.code,
        lastHeartbeatAt: health.ok ? health.lastHeartbeatAt : undefined,
        maxAgeMs: HEARTBEAT_MAX_AGE_MS,
      },
    });
  }

  return { healthy, stale, health };
}
