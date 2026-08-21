/**
 * Dedicated-fleet liveness monitor: answers on a schedule the question no
 * other sweep asks — "do dedicated agents exist that should be reachable and
 * are not?" (#22548). The heartbeat cycle iterates only `running` dedicated
 * rows, so a fleet whose every row sits in `error` gives it nothing to
 * iterate and it reports healthy by having nothing to say; a 36-hour total
 * outage of the dedicated product produced silence that way. This monitor
 * looks at the whole non-deleted dedicated census instead and alerts when
 * the fleet is non-empty with zero rows serving.
 *
 * It also publishes provisioning success measured on the `jobs` ledger
 * (`type='agent_provision'`) rather than on sandbox `status`, which is
 * written at INSERT and cannot testify to provisioning success. Invoked
 * every minute from the Worker cron alongside the provisioning-worker
 * heartbeat monitor; alert fan-out reuses the provisioning ops channels
 * with its own PagerDuty dedup key so a sustained outage is one incident.
 */

import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { jobsRepository } from "../../db/repositories/jobs";
import { JOB_TYPES } from "./provisioning-job-types";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

/** PagerDuty dedup key: one incident per unreachable-fleet episode. */
export const DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY = "dedicated-fleet-unreachable";

/** Window over which provisioning success is measured on the jobs ledger. */
export const PROVISION_SUCCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DedicatedFleetLiveness {
  /** Non-deleted, non-warm-pool dedicated rows, total and by status. */
  fleetTotal: number;
  fleetRunning: number;
  fleetByStatus: Record<string, number>;
  /** True when dedicated agents exist and none is serving — the alarm shape. */
  unreachable: boolean;
  /** agent_provision job outcomes in the trailing window, by status. */
  provisionWindowMs: number;
  provisionJobsByStatus: Record<string, number>;
  provisionCompleted: number;
  provisionFailed: number;
  /**
   * completed / (completed + failed) over the window; null when no
   * agent_provision job settled in the window (no data is not 100%).
   */
  provisionSuccessRate: number | null;
}

function toStatusCounts(rows: Array<{ status: string; count: number }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

/**
 * Compute the liveness DTO and alert when the fleet is unreachable.
 * `deps` are injectable for tests; production uses the real repositories,
 * the shared provisioning ops alert channels, and the wall clock.
 */
export async function monitorDedicatedFleetLiveness(
  deps: {
    summarizeFleet?: () => Promise<Array<{ status: string; count: number }>>;
    summarizeProvisionJobs?: (since: Date) => Promise<Array<{ status: string; count: number }>>;
    alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
    now?: () => number;
  } = {},
): Promise<DedicatedFleetLiveness> {
  const summarizeFleet =
    deps.summarizeFleet ?? (() => agentSandboxesRepository.summarizeDedicatedFleet());
  const summarizeProvisionJobs =
    deps.summarizeProvisionJobs ??
    ((since: Date) =>
      jobsRepository.summarizeOutcomesByTypeSince(JOB_TYPES.AGENT_PROVISION, since));
  const alert = deps.alert ?? sendProvisioningWorkerAlert;
  const nowMs = (deps.now ?? Date.now)();

  const since = new Date(nowMs - PROVISION_SUCCESS_WINDOW_MS);
  const [fleetRows, jobRows] = await Promise.all([summarizeFleet(), summarizeProvisionJobs(since)]);

  const fleetByStatus = toStatusCounts(fleetRows);
  const fleetTotal = Object.values(fleetByStatus).reduce((sum, n) => sum + n, 0);
  const fleetRunning = fleetByStatus.running ?? 0;
  const unreachable = fleetTotal > 0 && fleetRunning === 0;

  const provisionJobsByStatus = toStatusCounts(jobRows);
  const provisionCompleted = provisionJobsByStatus.completed ?? 0;
  const provisionFailed = provisionJobsByStatus.failed ?? 0;
  const settled = provisionCompleted + provisionFailed;
  const provisionSuccessRate = settled > 0 ? provisionCompleted / settled : null;

  if (unreachable) {
    await alert({
      title: "Dedicated agent fleet is unreachable",
      message:
        `${fleetTotal} dedicated agent${fleetTotal === 1 ? "" : "s"} exist and NONE is running — ` +
        "every paid dedicated agent is currently unreachable. The heartbeat sweep iterates only " +
        "running rows, so it cannot see this condition; treat it as a product outage, not noise.",
      details: {
        code: "DEDICATED_FLEET_UNREACHABLE",
        fleetTotal,
        fleetByStatus,
        provisionSuccessRate,
        provisionJobsByStatus,
        provisionWindowMs: PROVISION_SUCCESS_WINDOW_MS,
      },
      dedupKey: DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY,
    });
  }

  return {
    fleetTotal,
    fleetRunning,
    fleetByStatus,
    unreachable,
    provisionWindowMs: PROVISION_SUCCESS_WINDOW_MS,
    provisionJobsByStatus,
    provisionCompleted,
    provisionFailed,
    provisionSuccessRate,
  };
}
