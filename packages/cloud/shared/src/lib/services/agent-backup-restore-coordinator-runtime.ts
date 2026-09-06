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

export type AgentBackupRestoreCoordinatorConfig =
  | { enabled: false }
  | {
      enabled: true;
      workerId: string;
      claimMs: number;
      retryBaseMs: number;
      /** Explicit restore only; node-loss failover consumes this authority later. */
      automaticFailoverEnabled: false;
    };

/**
 * Flags are parsed as strictly as the integer tunables below: `"1"` is on,
 * unset / empty / `"0"` is off, and any OTHER value is a configuration error
 * rather than a silent off.
 *
 * A bare `=== "1"` test defeats both guarantees in this file's header, because
 * every value that is not `"1"` reads as off — including values that plainly
 * mean on. `AGENT_BACKUP_RESTORE_FAILOVER_ENABLED=true` was neither refused
 * for missing its parent nor rejected as unimplemented; an operator asking for
 * failover got a running coordinator with failover silently off.
 * `AGENT_BACKUP_RESTORE_COORDINATOR_ENABLED=true` left the coordinator
 * disabled while the deployment that set it believed otherwise.
 *
 * `"0"` is accepted as off on purpose: it is unambiguous intent, and rejecting
 * it would turn a deployment that means "off" into a boot failure — trading
 * this bug for a worse one. Only genuinely ambiguous values are refused.
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
    automaticFailoverEnabled: false,
  };
}
