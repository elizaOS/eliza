/**
 * Fail-closed gate for the restore coordinator.
 *
 * Reading configuration while disabled is itself a hazard: a half-configured
 * deployment that silently picks up defaults is how an off-by-default feature
 * becomes on. So the disabled branch returns before any tunable is read, and a
 * dependent flag set without its parent is an error rather than a no-op.
 */

/** Claim durations are bounded by the same window the DB shape check enforces. */
const MIN_CLAIM_MS = 1_000;
const MAX_CLAIM_MS = 3_600_000;
const DEFAULT_CLAIM_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_MS = 3_600_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ATTEMPTS = 50;

export type AgentBackupRestoreCoordinatorConfig =
  | { enabled: false }
  | {
      enabled: true;
      workerId: string;
      claimMs: number;
      retryBaseMs: number;
      /** Pre-boot attempts before a restore is closed without touching its route. */
      maxAttempts: number;
      /** Explicit restore only; node-loss failover consumes this authority later. */
      automaticFailoverEnabled: false;
    };

export type AgentBackupRestoreEnabledCoordinatorConfig = Extract<
  AgentBackupRestoreCoordinatorConfig,
  { enabled: true }
>;

/**
 * `"1"` is on; unset, empty, or `"0"` is off; any other value is a
 * configuration error. A bare `=== "1"` check would read `true` as off and
 * silently leave the coordinator (or the unimplemented failover refusal)
 * inactive while the deployment believes otherwise.
 */
function readStrictFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw !== "1") {
    throw new Error(`${name} must be "1" or "0" when set, or left unset`);
  }
  return true;
}

function readBoundedInteger(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = params.env[params.name];
  if (raw === undefined || raw === "") return params.fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${params.name} must be a canonical positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
    throw new Error(`${params.name} must be between ${params.min} and ${params.max}`);
  }
  return value;
}

export function readAgentBackupRestoreCoordinatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentBackupRestoreCoordinatorConfig {
  const failoverEnabled = readStrictFlag(env, "AGENT_BACKUP_RESTORE_FAILOVER_ENABLED");
  if (!readStrictFlag(env, "AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED")) {
    if (failoverEnabled) {
      throw new Error(
        "AGENT_BACKUP_RESTORE_FAILOVER_ENABLED requires AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED=1",
      );
    }
    return { enabled: false };
  }
  if (failoverEnabled) {
    throw new Error(
      "AGENT_BACKUP_RESTORE_FAILOVER_ENABLED is not implemented; explicit restore only",
    );
  }

  const workerId = env.AGENT_BACKUP_RESTORE_WORKER_ID;
  if (!workerId || workerId.trim() !== workerId || workerId.includes("\0")) {
    throw new Error(
      "AGENT_BACKUP_RESTORE_WORKER_ID must be explicitly configured when the restore coordinator is enabled",
    );
  }

  return {
    enabled: true,
    workerId,
    claimMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_RESTORE_CLAIM_MS",
      fallback: DEFAULT_CLAIM_MS,
      min: MIN_CLAIM_MS,
      max: MAX_CLAIM_MS,
    }),
    retryBaseMs: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_RESTORE_RETRY_BASE_MS",
      fallback: DEFAULT_RETRY_BASE_MS,
      min: 1,
      max: MAX_RETRY_MS,
    }),
    maxAttempts: readBoundedInteger({
      env,
      name: "AGENT_BACKUP_RESTORE_MAX_ATTEMPTS",
      fallback: DEFAULT_MAX_ATTEMPTS,
      min: 1,
      max: MAX_ATTEMPTS,
    }),
    automaticFailoverEnabled: false,
  };
}
