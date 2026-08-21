/**
 * Detects a control-plane→agent tailnet path outage from the provisioning
 * daemon's own health-probe stream and makes it loud.
 *
 * The 2026-08-18 headscale ACL regression turned EVERY tailnet health probe
 * into a 360 s timeout for a day and a half without a single alert: each probe
 * failure looked like one slow container, provisioning retried, and nobody was
 * paged (elizaOS/eliza#22547 proof 7). One sick container cannot distinguish
 * itself from a severed path, but a run of consecutive timeouts across
 * DISTINCT containers with zero passes in between can — that is the signature
 * this monitor alarms on.
 *
 * The daemon (docker-sandbox-provider) reports every terminal probe outcome
 * here; the monitor fires the shared provisioning ops alert channels
 * (structured error log always; Slack/PagerDuty when configured) under its own
 * PagerDuty dedup key, re-alerts on a throttle while the outage persists, and
 * logs recovery on the first subsequent pass.
 */

import { logger } from "../utils/logger";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

/** Consecutive terminal probe timeouts required before the path alarm fires. */
export const TAILNET_ALARM_CONSECUTIVE_TIMEOUTS = 3;

/**
 * Distinct containers that must be represented in the timeout run. A single
 * container timing out repeatedly is a sick agent, not a severed path.
 */
export const TAILNET_ALARM_MIN_DISTINCT_CONTAINERS = 2;

/** Re-alert cadence while the outage persists (one PagerDuty incident via dedup). */
export const TAILNET_ALARM_REALERT_MS = 30 * 60_000;

/** PagerDuty dedup key: keeps this a separate incident from the daemon heartbeat. */
export const TAILNET_ALARM_DEDUP_KEY = "tailnet-agent-path-unreachable";

export interface TailnetProbeOutcome {
  containerName: string;
  outcome: "passed" | "timed_out";
}

/**
 * Sliding outage detector over terminal tailnet probe outcomes. One instance
 * lives per daemon process; tests construct their own with injected deps.
 */
export class TailnetPathMonitor {
  private consecutiveTimeouts = 0;
  private readonly timedOutContainers = new Set<string>();
  private firstTimeoutAtMs: number | null = null;
  private lastAlertAtMs: number | null = null;
  private alarmActive = false;

  constructor(
    private readonly deps: {
      alert?: (alert: DaemonHealthAlert) => Promise<void>;
      now?: () => number;
    } = {},
  ) {}

  /** True while the path-outage condition currently holds. */
  get active(): boolean {
    return this.alarmActive;
  }

  /**
   * Record one terminal probe outcome. Never throws: an alerting failure must
   * not take down the provisioning loop that observed it.
   */
  async record(probe: TailnetProbeOutcome): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    if (probe.outcome === "passed") {
      if (this.alarmActive) {
        logger.info("[TailnetPathMonitor] Tailnet agent path recovered", {
          containerName: probe.containerName,
          consecutiveTimeouts: this.consecutiveTimeouts,
          outageStartedAt:
            this.firstTimeoutAtMs === null ? null : new Date(this.firstTimeoutAtMs).toISOString(),
        });
      }
      this.consecutiveTimeouts = 0;
      this.timedOutContainers.clear();
      this.firstTimeoutAtMs = null;
      this.lastAlertAtMs = null;
      this.alarmActive = false;
      return;
    }

    this.consecutiveTimeouts += 1;
    this.timedOutContainers.add(probe.containerName);
    if (this.firstTimeoutAtMs === null) this.firstTimeoutAtMs = now;

    const conditionMet =
      this.consecutiveTimeouts >= TAILNET_ALARM_CONSECUTIVE_TIMEOUTS &&
      this.timedOutContainers.size >= TAILNET_ALARM_MIN_DISTINCT_CONTAINERS;
    if (!conditionMet) return;

    const due = this.lastAlertAtMs === null || now - this.lastAlertAtMs >= TAILNET_ALARM_REALERT_MS;
    this.alarmActive = true;
    if (!due) return;
    this.lastAlertAtMs = now;

    try {
      await (this.deps.alert ?? sendProvisioningWorkerAlert)({
        title: "Control-plane → agent tailnet path appears down",
        message:
          `${this.consecutiveTimeouts} consecutive tailnet health probes timed out across ` +
          `${this.timedOutContainers.size} distinct containers with zero passes in between. ` +
          "This is the signature of a severed headscale path (e.g. an ACL dropping " +
          "tag:eliza-proxy → tag:agent), not one sick agent. Check the control plane's " +
          "netmap and the deployed /etc/headscale/acl.hujson before restarting anything.",
        details: {
          code: "TAILNET_AGENT_PATH_UNREACHABLE",
          consecutiveTimeouts: this.consecutiveTimeouts,
          distinctContainers: [...this.timedOutContainers].slice(0, 10),
          firstTimeoutAt:
            this.firstTimeoutAtMs === null ? null : new Date(this.firstTimeoutAtMs).toISOString(),
        },
        dedupKey: TAILNET_ALARM_DEDUP_KEY,
      });
    } catch (error) {
      // error-policy:J7 alert delivery is diagnostics; the probe loop that
      // observed the outage must keep running (the structured error log inside
      // sendProvisioningWorkerAlert already fired before any channel send).
      logger.warn("[TailnetPathMonitor] Failed to dispatch tailnet path alert", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Process-wide monitor used by the daemon's sandbox provider. */
export const tailnetPathMonitor = new TailnetPathMonitor();
