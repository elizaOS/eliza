/**
 * Dedicated-fleet liveness monitor: answers on a schedule the question no
 * other sweep asks — "do dedicated agents exist that should be reachable and
 * are not?" (#22548). The heartbeat cycle iterates only `running` dedicated
 * rows, so a fleet whose every row sits in `error` gives it nothing to
 * iterate and it reports healthy by having nothing to say; a 36-hour total
 * outage of the dedicated product produced silence that way.
 *
 * "Should be reachable" is a contract, not a status string. The census this
 * monitor pages on is scoped by BOTH axes — the tier's serving contract and
 * the row's lifecycle state — because `dedicated-lazy` is explicitly allowed
 * to sleep and `stopped`/`sleeping`/`deletion_*` rows are off on purpose. A
 * fleet of healthy sleeping lazy agents must never page. Rows outside the
 * expected-reachable census are still counted and reported, so the alert and
 * the cron log carry the whole fleet picture, but they cannot raise the alarm.
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
import type { AgentExecutionTier, AgentSandboxStatus } from "../../db/schemas/agent-sandboxes";
import { JOB_TYPES } from "./provisioning-job-types";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

/** PagerDuty dedup key: one incident per unreachable-fleet episode. */
export const DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY = "dedicated-fleet-unreachable";

/** Window over which provisioning success is measured on the jobs ledger. */
export const PROVISION_SUCCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Lifecycle states in which a container-backed row asserts that a live
 * container should exist right now:
 *   running       — serving; the only state that satisfies the assertion.
 *   disconnected  — was serving, tunnel dropped; should be reachable, is not.
 *   error         — was meant to be up and failed; the 36h-outage shape.
 *
 * Everything else is deliberately excluded and can never raise the alarm:
 * `sleeping`/`stopped` are contractual off-states (scale-to-zero, suspend,
 * billing shutdown), `pending`/`provisioning` are not-yet-live, and
 * `deletion_pending`/`deletion_failed` are on their way out — an operator
 * already owns those, and a fleet of them is not an outage.
 */
export const FLEET_EXPECTED_REACHABLE_STATUSES = [
  "running",
  "disconnected",
  "error",
] as const satisfies readonly AgentSandboxStatus[];

/**
 * Tiers whose rows may raise the fleet alarm. `shared` is container-free and
 * never enters the census at all (the repository query excludes it).
 *
 * `dedicated-lazy` is included but is NOT thereby claimed to be always-on:
 * its right to sleep is enforced by the lifecycle axis above, which drops
 * every sleeping/stopped lazy row from the census. A lazy row only counts
 * once it has been woken and is therefore asserting a live container —
 * exactly the state in which its unreachability is a real user-facing
 * failure. `dedicated-always` and `custom` carry standing serving authority
 * and count whenever they make the same assertion.
 */
export const FLEET_ALARM_TIERS = [
  "dedicated-lazy",
  "dedicated-always",
  "custom",
] as const satisfies readonly AgentExecutionTier[];

/** One grouped census row as returned by the repository. */
export interface FleetCensusRow {
  execution_tier: string;
  status: string;
  count: number;
}

/**
 * True when a row of this tier and lifecycle state is contractually supposed
 * to be reachable at this instant. This is the whole liveness contract: the
 * alarm counts only rows for which it answers true, so a fleet that is merely
 * asleep, suspended, or being deleted cannot page.
 */
export function isFleetRowExpectedReachable(executionTier: string, status: string): boolean {
  return (
    (FLEET_ALARM_TIERS as readonly string[]).includes(executionTier) &&
    (FLEET_EXPECTED_REACHABLE_STATUSES as readonly string[]).includes(status)
  );
}

export interface DedicatedFleetLiveness {
  /**
   * Rows that should be reachable right now: container-backed tiers in a
   * lifecycle state asserting a live container. This is the census the alarm
   * is computed on.
   */
  expectedReachableTotal: number;
  expectedReachableRunning: number;
  expectedReachableByStatus: Record<string, number>;
  /**
   * Every non-deleted, non-warm-pool container-backed row, including the
   * contractual off-states excluded from the alarm census. Reported for
   * context so an operator can tell "no agents exist" from "all are asleep".
   */
  fleetTotal: number;
  fleetByTierStatus: Record<string, number>;
  /** Rows that exist but are contractually off, and therefore not an alarm. */
  offContractTotal: number;
  /** True when agents that should be reachable exist and none is serving. */
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
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + row.count;
  return counts;
}

/**
 * Compute the liveness DTO and alert when the fleet is unreachable.
 * `deps` are injectable for tests; production uses the real repositories,
 * the shared provisioning ops alert channels, and the wall clock.
 */
export async function monitorDedicatedFleetLiveness(
  deps: {
    summarizeFleet?: () => Promise<FleetCensusRow[]>;
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
  const [censusRows, jobRows] = await Promise.all([
    summarizeFleet(),
    summarizeProvisionJobs(since),
  ]);

  const fleetByTierStatus: Record<string, number> = {};
  const expectedReachable: Array<{ status: string; count: number }> = [];
  let fleetTotal = 0;
  for (const row of censusRows) {
    const key = `${row.execution_tier}:${row.status}`;
    fleetByTierStatus[key] = (fleetByTierStatus[key] ?? 0) + row.count;
    fleetTotal += row.count;
    if (isFleetRowExpectedReachable(row.execution_tier, row.status)) {
      expectedReachable.push({ status: row.status, count: row.count });
    }
  }

  const expectedReachableByStatus = toStatusCounts(expectedReachable);
  const expectedReachableTotal = Object.values(expectedReachableByStatus).reduce(
    (sum, n) => sum + n,
    0,
  );
  const expectedReachableRunning = expectedReachableByStatus.running ?? 0;
  const offContractTotal = fleetTotal - expectedReachableTotal;
  const unreachable = expectedReachableTotal > 0 && expectedReachableRunning === 0;

  const provisionJobsByStatus = toStatusCounts(jobRows);
  const provisionCompleted = provisionJobsByStatus.completed ?? 0;
  const provisionFailed = provisionJobsByStatus.failed ?? 0;
  const settled = provisionCompleted + provisionFailed;
  const provisionSuccessRate = settled > 0 ? provisionCompleted / settled : null;

  if (unreachable) {
    await alert({
      title: "Dedicated agent fleet is unreachable",
      message:
        `${expectedReachableTotal} dedicated agent${expectedReachableTotal === 1 ? "" : "s"} ` +
        "should be reachable right now and NONE is running — every dedicated agent that is " +
        "contractually live is currently unreachable. The heartbeat sweep iterates only running " +
        "rows, so it cannot see this condition; treat it as a product outage, not noise. " +
        `${offContractTotal} further row(s) are contractually off (asleep/suspended/deleting) ` +
        "and are excluded from this count.",
      details: {
        code: "DEDICATED_FLEET_UNREACHABLE",
        expectedReachableTotal,
        expectedReachableByStatus,
        fleetTotal,
        fleetByTierStatus,
        offContractTotal,
        provisionSuccessRate,
        provisionJobsByStatus,
        provisionWindowMs: PROVISION_SUCCESS_WINDOW_MS,
      },
      dedupKey: DEDICATED_FLEET_UNREACHABLE_DEDUP_KEY,
    });
  }

  return {
    expectedReachableTotal,
    expectedReachableRunning,
    expectedReachableByStatus,
    fleetTotal,
    fleetByTierStatus,
    offContractTotal,
    unreachable,
    provisionWindowMs: PROVISION_SUCCESS_WINDOW_MS,
    provisionJobsByStatus,
    provisionCompleted,
    provisionFailed,
    provisionSuccessRate,
  };
}
