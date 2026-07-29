/**
 * Fleet-level RPO monitoring for managed local-state agents.
 *
 * The provisioning daemon calls this beside restorability verification. It
 * reports disabled snapshot execution, absent/stale backups, unreachable or
 * unsupported images, backlog pressure, and repeated failures through the
 * shared ops channel. Per-agent fingerprints make repeated cycles idempotent.
 */

import { ElizaError } from "@elizaos/core";
import {
  agentSandboxBackupHealthRepository,
  BACKUP_UNREACHABLE_BRIDGE_SENTINEL,
  type BackupFleetProblem,
} from "../../db/repositories/agent-sandbox-backup-health";
import { logger } from "../utils/logger";
import {
  type DaemonHealthAlert,
  sendProvisioningWorkerAlert,
} from "./provisioning-worker-health-monitor";

const DEFAULT_TARGET_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_REPEATED_FAILURE_THRESHOLD = 3;
const DEFAULT_BACKLOG_ALERT_THRESHOLD = 200;
const DEFAULT_PROBLEM_LIMIT = 200;
const MAX_ALERT_AGENTS_PER_CYCLE = 50;
const ALERT_DEDUP_KEY = "agent-backup-fleet-health";
const GLOBAL_ALERT_SCOPE = "managed-local-state";

export interface BackupFleetHealthConfig {
  targetIntervalMs: number;
  repeatedFailureThreshold: number;
  backlogAlertThreshold: number;
  problemLimit: number;
}

export interface BackupFleetHealthSummary {
  laneEnabled: boolean;
  healthy: boolean;
  total: number;
  absent: number;
  stale: number;
  unsupported: number;
  unreachable: number;
  repeatedFailures: number;
  imageRefreshRequired: number;
  backlog: number;
  backlogPressure: boolean;
  oldestBackupAgeMs: number | null;
  newAlerts: number;
}

function positiveInteger(value: string | undefined, variable: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ElizaError(`${variable} must be a positive integer`, {
      code: "AGENT_BACKUP_FLEET_INVALID_CONFIG",
      context: { variable, value },
    });
  }
  return parsed;
}

export function readBackupFleetHealthConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackupFleetHealthConfig {
  return {
    targetIntervalMs:
      positiveInteger(
        env.AGENT_BACKUP_TARGET_INTERVAL_MINUTES,
        "AGENT_BACKUP_TARGET_INTERVAL_MINUTES",
        DEFAULT_TARGET_INTERVAL_MS / 60_000,
      ) * 60_000,
    repeatedFailureThreshold: positiveInteger(
      env.AGENT_BACKUP_FAILURE_ALERT_THRESHOLD,
      "AGENT_BACKUP_FAILURE_ALERT_THRESHOLD",
      DEFAULT_REPEATED_FAILURE_THRESHOLD,
    ),
    backlogAlertThreshold: positiveInteger(
      env.AGENT_BACKUP_BACKLOG_ALERT_THRESHOLD,
      "AGENT_BACKUP_BACKLOG_ALERT_THRESHOLD",
      DEFAULT_BACKLOG_ALERT_THRESHOLD,
    ),
    problemLimit: positiveInteger(
      env.AGENT_BACKUP_HEALTH_PROBLEM_LIMIT,
      "AGENT_BACKUP_HEALTH_PROBLEM_LIMIT",
      DEFAULT_PROBLEM_LIMIT,
    ),
  };
}

export function isManagedSnapshotLaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELIZA_SNAPSHOT_JOBS_ENABLED === "true";
}

function problemFingerprint(params: {
  problem: BackupFleetProblem;
  nowMs: number;
  config: BackupFleetHealthConfig;
}): string | null {
  const issues: string[] = [];
  if (
    params.problem.bridgeUrl === null ||
    params.problem.bridgeUrl === BACKUP_UNREACHABLE_BRIDGE_SENTINEL
  ) {
    issues.push("unreachable");
  }
  if (
    params.problem.capability === "unsupported" &&
    params.problem.imageDigest !== null &&
    params.problem.imageIdentity === params.problem.imageDigest
  ) {
    issues.push("unsupported");
  }
  if (params.problem.backupRequired) issues.push("image-backup-required");

  const dueReferenceMs =
    params.problem.lastBackupAt?.getTime() ?? params.problem.createdAt.getTime();
  const ageMs = Math.max(0, params.nowMs - dueReferenceMs);
  if (params.problem.lastBackupAt === null && ageMs > params.config.targetIntervalMs) {
    issues.push("absent");
  } else if (params.problem.lastBackupAt !== null && ageMs > 2 * params.config.targetIntervalMs) {
    issues.push("stale");
  }
  if (params.problem.consecutiveFailures >= params.config.repeatedFailureThreshold) {
    issues.push("repeated-failures");
  }

  return issues.length === 0 ? null : issues.sort().join("+");
}

/**
 * Roll up backup health and emit one grouped ops alert for newly unhealthy
 * agents. A row claims its failure fingerprint before alert fan-out, so
 * overlapping daemon cycles cannot duplicate Slack/PagerDuty incidents.
 */
export async function runAgentBackupFleetHealthCycle(
  deps: {
    /** Compatibility-only observer clock; PostgreSQL owns health cutoffs. */
    now?: () => Date;
    config?: BackupFleetHealthConfig;
    laneEnabled?: boolean;
    alert?: (alert: DaemonHealthAlert) => void | Promise<void>;
  } = {},
): Promise<BackupFleetHealthSummary> {
  const config = deps.config ?? readBackupFleetHealthConfig();
  const laneEnabled = deps.laneEnabled ?? isManagedSnapshotLaneEnabled();
  const alert = deps.alert ?? sendProvisioningWorkerAlert;
  const fleet = await agentSandboxBackupHealthRepository.readFleetSnapshot({
    targetIntervalMs: config.targetIntervalMs,
    repeatedFailureThreshold: config.repeatedFailureThreshold,
    problemLimit: config.problemLimit,
  });
  const backlogPressure = fleet.backlog > config.backlogAlertThreshold;
  const globalIssues: string[] = [];
  if (!laneEnabled) globalIssues.push("lane-disabled");
  if (backlogPressure) globalIssues.push("backlog-pressure");
  const globalFingerprint = globalIssues.length === 0 ? null : globalIssues.sort().join("+");
  let globalAlertClaimed = false;
  if (globalFingerprint === null) {
    await agentSandboxBackupHealthRepository.clearFleetAlertFingerprint(GLOBAL_ALERT_SCOPE);
  } else {
    globalAlertClaimed = await agentSandboxBackupHealthRepository.claimFleetAlertFingerprint({
      scope: GLOBAL_ALERT_SCOPE,
      fingerprint: globalFingerprint,
    });
  }

  const newlyAlerted: Array<{
    agentId: string;
    organizationId: string;
    fingerprint: string;
    lastError: string | null;
  }> = [];
  for (const problem of fleet.problems) {
    const fingerprint = problemFingerprint({
      problem,
      nowMs: fleet.asOf.getTime(),
      config,
    });
    if (fingerprint === null) {
      if (problem.alertFingerprint !== null) {
        await agentSandboxBackupHealthRepository.clearAlertFingerprint(problem.id);
      }
      continue;
    }
    // Do not durably claim more agents than this alert can identify. The
    // repository orders unclaimed rows first, so remaining problems roll into
    // later cycles instead of becoming permanently invisible behind truncation.
    if (newlyAlerted.length >= MAX_ALERT_AGENTS_PER_CYCLE) continue;
    const claimed = await agentSandboxBackupHealthRepository.claimAlertFingerprint({
      sandboxRecordId: problem.id,
      fingerprint,
    });
    if (claimed) {
      newlyAlerted.push({
        agentId: problem.id,
        organizationId: problem.organizationId,
        fingerprint,
        lastError: problem.lastError,
      });
    }
  }

  const healthy =
    laneEnabled &&
    fleet.absent === 0 &&
    fleet.stale === 0 &&
    fleet.unsupported === 0 &&
    fleet.unreachable === 0 &&
    fleet.repeatedFailures === 0 &&
    fleet.imageRefreshRequired === 0 &&
    !backlogPressure;
  const summary: BackupFleetHealthSummary = {
    laneEnabled,
    healthy,
    total: fleet.total,
    absent: fleet.absent,
    stale: fleet.stale,
    unsupported: fleet.unsupported,
    unreachable: fleet.unreachable,
    repeatedFailures: fleet.repeatedFailures,
    imageRefreshRequired: fleet.imageRefreshRequired,
    backlog: fleet.backlog,
    backlogPressure,
    oldestBackupAgeMs: fleet.oldestBackupAt
      ? Math.max(0, fleet.asOf.getTime() - fleet.oldestBackupAt.getTime())
      : null,
    newAlerts: newlyAlerted.length + (globalAlertClaimed ? 1 : 0),
  };

  if (!healthy) {
    logger.error("[AgentBackupFleetHealth] managed backup RPO is unhealthy", {
      ...summary,
    });
  }

  if (newlyAlerted.length > 0 || globalAlertClaimed) {
    try {
      await alert({
        title: "Managed agent backup RPO is unhealthy",
        message:
          "The managed local-state fleet has agents without a current off-box backup. " +
          "Inspect the scheduler backlog, snapshot lane, image capability, and recent failures.",
        details: {
          ...summary,
          globalIssues,
          newlyAlerted,
        },
        dedupKey: ALERT_DEDUP_KEY,
      });
    } catch (error) {
      await Promise.all(
        newlyAlerted.map((item) =>
          agentSandboxBackupHealthRepository.releaseAlertFingerprint(
            item.agentId,
            item.fingerprint,
          ),
        ),
      );
      if (globalAlertClaimed && globalFingerprint !== null) {
        await agentSandboxBackupHealthRepository.releaseFleetAlertFingerprint(
          GLOBAL_ALERT_SCOPE,
          globalFingerprint,
        );
      }
      // error-policy:J2 context-adding rethrow — release this cycle's durable
      // claims so the next monitor tick retries a delivery that did not finish.
      throw new ElizaError("Managed backup fleet alert delivery failed", {
        code: "AGENT_BACKUP_FLEET_ALERT_FAILED",
        context: { newlyAlerted: newlyAlerted.length },
        cause: error,
      });
    }
  }

  return summary;
}

export const BACKUP_FLEET_DEFAULT_TARGET_INTERVAL_MS = DEFAULT_TARGET_INTERVAL_MS;
