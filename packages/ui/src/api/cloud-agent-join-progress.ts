/**
 * Typed progress and failure metadata for Cloud agent selection and startup.
 * The join UI consumes only opaque agent/job correlation ids; credentials and
 * account identity never enter this channel.
 */

import { ElizaError } from "@elizaos/core";
import type {
  CloudAgentJoinPhase,
  CloudAgentJoinProgress,
  CloudAgentJoinSource,
} from "./client-types-cloud";

const JOIN_PROGRESS_FIELD = "cloudAgentJoinProgress";

const JOIN_PHASES = new Set<CloudAgentJoinPhase>([
  "listing",
  "reusing",
  "waking",
  "resuming",
  "provisioning",
  "running",
]);

const JOIN_SOURCES = new Set<CloudAgentJoinSource>([
  "existing_running",
  "existing_wake",
  "existing_resume",
  "existing_provision",
  "shared_runtime",
  "warm_pool",
  "warm_pool_recovery",
  "cold_provision",
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCloudAgentJoinProgress(
  value: unknown,
): value is CloudAgentJoinProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Partial<CloudAgentJoinProgress>;
  return (
    typeof progress.phase === "string" &&
    JOIN_PHASES.has(progress.phase as CloudAgentJoinPhase) &&
    (progress.source === null ||
      (typeof progress.source === "string" &&
        JOIN_SOURCES.has(progress.source as CloudAgentJoinSource))) &&
    isNullableString(progress.agentId) &&
    isNullableString(progress.jobId) &&
    typeof progress.status === "string" &&
    typeof progress.elapsedMs === "number" &&
    Number.isFinite(progress.elapsedMs) &&
    progress.elapsedMs >= 0 &&
    isNullableString(progress.correlationId)
  );
}

/** Attach a sanitized state receipt while preserving the transport cause. */
export function cloudAgentJoinError(
  message: string,
  progress: CloudAgentJoinProgress,
  cause?: unknown,
): Error {
  return new ElizaError(message, {
    code: "CLOUD_AGENT_JOIN_FAILED",
    context: { [JOIN_PROGRESS_FIELD]: progress },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Recover the most recent typed receipt from an error/cause chain. */
export function cloudAgentJoinProgressFromError(
  error: unknown,
): CloudAgentJoinProgress | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const candidate =
      current instanceof ElizaError
        ? current.context?.[JOIN_PROGRESS_FIELD]
        : (current as Error & Record<string, unknown>)[JOIN_PROGRESS_FIELD];
    if (isCloudAgentJoinProgress(candidate)) return candidate;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Polls retry only transport failures with a concrete short-lived recovery
 * contract. Auth, credit, ownership, conflict, and worker-capacity failures
 * deliberately exclude 401/402/403/404/409/503 and fail immediately.
 */
export function isRetryableCloudAgentJoinError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const status = (current as Error & { status?: unknown }).status;
    if (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status === 502 ||
      status === 504
    ) {
      return true;
    }
    if (typeof status === "number") return false;
    if (current instanceof TypeError) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}
