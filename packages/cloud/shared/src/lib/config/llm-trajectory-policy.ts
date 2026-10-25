/**
 * Deployment policy for recording model calls (LLM trajectories).
 *
 * Recording is a deployment decision, not a per-user consent: recorded calls
 * stay inside the Cloud trust boundary, are encrypted at rest, and expire after
 * the retention window. Production defaults OFF so nothing is kept unless an
 * operator opts in explicitly; every other environment defaults ON.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { isProductionDeployment } from "./deployment-environment";

type EnvLike = Record<string, string | undefined>;

export const DEFAULT_LLM_TRAJECTORY_RETENTION_DAYS = 90;

/** A trajectory capture/retention env var holds a value this build rejects. */
export class TrajectoryPolicyConfigError extends Error {
  readonly code = "TRAJECTORY_POLICY_CONFIG_INVALID";

  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = "TrajectoryPolicyConfigError";
  }
}

export interface TrajectoryCapturePolicy {
  enabled: boolean;
  /** `explicit` = `LLM_TRAJECTORY_CAPTURE` decided; otherwise the deployment default. */
  source: "explicit" | "deployment-default";
}

/**
 * `LLM_TRAJECTORY_CAPTURE=on|off` wins. Unset: production is off, everything
 * else is on. Any other value is a configuration error, never a guess.
 */
export function resolveTrajectoryCapturePolicy(
  env: EnvLike = getCloudAwareEnv(),
): TrajectoryCapturePolicy {
  const raw = env.LLM_TRAJECTORY_CAPTURE;
  if (raw !== undefined && raw !== "") {
    if (raw === "on") return { enabled: true, source: "explicit" };
    if (raw === "off") return { enabled: false, source: "explicit" };
    throw new TrajectoryPolicyConfigError(
      "LLM_TRAJECTORY_CAPTURE",
      `LLM_TRAJECTORY_CAPTURE must be "on" or "off" (got "${raw}")`,
    );
  }
  return { enabled: !isProductionDeployment(env), source: "deployment-default" };
}

/** Days a recorded model call is kept before the purge cron deletes it. */
export function resolveTrajectoryRetentionDays(env: EnvLike = getCloudAwareEnv()): number {
  const raw = env.LLM_TRAJECTORY_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_LLM_TRAJECTORY_RETENTION_DAYS;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new TrajectoryPolicyConfigError(
      "LLM_TRAJECTORY_RETENTION_DAYS",
      `LLM_TRAJECTORY_RETENTION_DAYS must be a positive whole number of days (got "${raw}")`,
    );
  }
  return Number(raw);
}

/** Read-only disclosure of the deployment's model-call recording policy. */
export interface ModelCallRecordingDisclosure extends TrajectoryCapturePolicy {
  retentionDays: number;
}

export function describeModelCallRecording(
  env: EnvLike = getCloudAwareEnv(),
): ModelCallRecordingDisclosure {
  return {
    ...resolveTrajectoryCapturePolicy(env),
    retentionDays: resolveTrajectoryRetentionDays(env),
  };
}
