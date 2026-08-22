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

import { safeFetch } from "../security/safe-fetch";
import { logger } from "../utils/logger";
import { writeCloudApiDbHeartbeat } from "./cloud-api-db-heartbeat";
import {
  checkProvisioningWorkerHealth,
  PROVISIONING_WORKER_HEARTBEAT_TTL_S,
  type ProvisioningWorkerHealth,
} from "./provisioning-worker-health";

const ALERT_REQUEST_TIMEOUT_MS = 15_000;
const ALERT_TITLE_MAX_CHARS = 512;
const ALERT_MESSAGE_MAX_CHARS = 4_000;
const ALERT_DETAILS_MAX_CHARS = 8_000;

type AlertTransport = (input: string, init?: RequestInit) => Promise<Response>;

function boundedAlertText(value: string, maxChars: number): string {
  const wellFormed = value.toWellFormed();
  return wellFormed.length <= maxChars
    ? wellFormed
    : `${wellFormed.slice(0, maxChars - 1).toWellFormed()}…`;
}

function boundedAlertDetails(details: Record<string, unknown>): Record<string, unknown> {
  let serialized: string | undefined;
  try {
    // PATH-LOCAL cycle guard, not visit-global: mark on descent, clear on
    // exit — a repeated sibling reference (honest DAG, e.g. one shared config
    // object under two keys) still renders in full, while a true back-edge is
    // cut. Mirrors the pattern prompt-flatten.ts documents.
    const inPath = new WeakSet<object>();
    const walk = (value: unknown): unknown => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "string") {
        return boundedAlertText(value, ALERT_MESSAGE_MAX_CHARS);
      }
      if (typeof value === "object" && value !== null) {
        if (inPath.has(value)) return "[circular]";
        inPath.add(value);
        let out: unknown;
        if (Array.isArray(value)) {
          out = value.map(walk);
        } else {
          const record: Record<string, unknown> = {};
          for (const [key, child] of Object.entries(value)) {
            record[key] = walk(child);
          }
          out = record;
        }
        inPath.delete(value);
        return out;
      }
      return value;
    };
    serialized = JSON.stringify(walk(details));
  } catch {
    // error-policy:J3 untrusted diagnostic details become an explicit invalid
    // marker instead of preventing every configured alert channel from firing.
    return { serializationError: "Alert details were not serializable" };
  }

  if (serialized === undefined) {
    return { serializationError: "Alert details did not serialize to JSON" };
  }

  if (serialized.length <= ALERT_DETAILS_MAX_CHARS) {
    const parsed: unknown = JSON.parse(serialized);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  }
  return {
    truncated: true,
    preview: boundedAlertText(serialized, ALERT_DETAILS_MAX_CHARS),
  };
}

/**
 * Bound every ops-alert hop so a hung webhook cannot pin the monitor. The
 * canonical transport validates and pins every redirect hop; redirects are
 * rejected here because alert POST bodies must never be replayed elsewhere.
 */
export async function alertFetch(
  input: string,
  init?: RequestInit,
  timeoutMs: number = ALERT_REQUEST_TIMEOUT_MS,
  transport: AlertTransport = safeFetch,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Alert request timeout must be a positive 32-bit safe integer");
  }
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineController.abort(new DOMException("Alert request timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    const signal = init?.signal
      ? AbortSignal.any([init.signal, deadlineController.signal])
      : deadlineController.signal;
    const response = await transport(input, {
      ...init,
      redirect: "error",
      signal,
    });
    try {
      if (!response.ok) {
        throw new Error(`Alert endpoint returned HTTP ${response.status}`);
      }
    } finally {
      try {
        await response.body?.cancel();
      } catch (cleanupError) {
        // error-policy:J6 best-effort teardown of an unused alert response body.
        logger.warn("[ProvisioningWorkerHealth] Failed to cancel alert response body", {
          error: cleanupError,
        });
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}

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
export async function sendProvisioningWorkerAlert(
  alert: DaemonHealthAlert,
  deps: { transport?: AlertTransport } = {},
): Promise<void> {
  const slackWebhook = process.env[ALERT_SLACK_WEBHOOK_ENV];
  const pagerDutyKey = process.env[ALERT_PAGERDUTY_KEY_ENV];
  const title = boundedAlertText(alert.title, ALERT_TITLE_MAX_CHARS);
  const message = boundedAlertText(alert.message, ALERT_MESSAGE_MAX_CHARS);
  const details = boundedAlertDetails(alert.details);
  logger.error(`[ProvisioningWorkerHealth] ${title}`, { message, ...details });

  const sends: Promise<unknown>[] = [];

  if (slackWebhook) {
    sends.push(
      alertFetch(
        slackWebhook,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `🚨 *[elizaOS Provisioning]* ${title}\n${message}`,
          }),
        },
        ALERT_REQUEST_TIMEOUT_MS,
        deps.transport,
      ),
    );
  }

  if (pagerDutyKey) {
    sends.push(
      alertFetch(
        "https://events.pagerduty.com/v2/enqueue",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routing_key: boundedAlertText(pagerDutyKey, ALERT_TITLE_MAX_CHARS),
            event_action: "trigger",
            dedup_key: boundedAlertText(
              alert.dedupKey ?? "provisioning-worker-unhealthy",
              ALERT_TITLE_MAX_CHARS,
            ),
            payload: {
              summary: `[elizaOS Provisioning] ${title}`,
              severity: "critical",
              source: "eliza-cloud-provisioning-worker",
              custom_details: { message, ...details },
            },
          }),
        },
        ALERT_REQUEST_TIMEOUT_MS,
        deps.transport,
      ),
    );
  }

  // error-policy:J7 alert-channel failures must be observable without killing
  // the scheduled monitor after its structured primary error was recorded.
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
