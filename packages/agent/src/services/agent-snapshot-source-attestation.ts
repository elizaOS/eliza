/**
 * Resolves the immutable provider-owned identity of a running snapshot source.
 * Capture compares this launch attestation with the requested upgrade binding
 * so an authenticated caller cannot make one placement vouch for another.
 */
import { ElizaError } from "@elizaos/core";
import {
  type AgentSnapshotSourceAttestation,
  type AgentSnapshotUpgradeBinding,
  validateAgentSnapshotSourceAttestation,
} from "./agent-backup.ts";
import { stableJson } from "./agent-snapshot-stream-protocol.ts";

const AGENT_SNAPSHOT_SOURCE_ATTESTATION_ENV = {
  sourceEnvironmentRevision: "ELIZA_SNAPSHOT_SOURCE_ENVIRONMENT_REVISION",
  sourceImageDigest: "ELIZA_SNAPSHOT_SOURCE_IMAGE_DIGEST",
  sourceSandboxId: "ELIZA_SNAPSHOT_SOURCE_SANDBOX_ID",
} as const;

function attestationError(message: string, code: string): ElizaError {
  return new ElizaError(message, {
    code,
    severity: "fatal",
  });
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (typeof value !== "string" || !value) {
    throw attestationError(
      "Snapshot source attestation is partially configured",
      "AGENT_SNAPSHOT_SOURCE_ATTESTATION_INVALID",
    );
  }
  return value;
}

export function resolveAgentSnapshotSourceAttestation(
  env: NodeJS.ProcessEnv = process.env,
): AgentSnapshotSourceAttestation | null {
  const values = Object.values(AGENT_SNAPSHOT_SOURCE_ATTESTATION_ENV).map(
    (name) => env[name],
  );
  if (values.every((value) => value === undefined)) return null;
  const revision = requiredEnvironmentValue(
    env,
    AGENT_SNAPSHOT_SOURCE_ATTESTATION_ENV.sourceEnvironmentRevision,
  );
  if (!/^(?:0|[1-9][0-9]*)$/.test(revision)) {
    throw attestationError(
      "Snapshot source environment revision is malformed",
      "AGENT_SNAPSHOT_SOURCE_ATTESTATION_INVALID",
    );
  }
  try {
    return validateAgentSnapshotSourceAttestation({
      sourceEnvironmentRevision: Number(revision),
      sourceImageDigest: requiredEnvironmentValue(
        env,
        AGENT_SNAPSHOT_SOURCE_ATTESTATION_ENV.sourceImageDigest,
      ),
      sourceSandboxId: requiredEnvironmentValue(
        env,
        AGENT_SNAPSHOT_SOURCE_ATTESTATION_ENV.sourceSandboxId,
      ),
    });
  } catch (cause) {
    // error-policy:J3 provider environment is untrusted; known typed
    // attestation failures pass through and all other validation errors become
    // an explicit invalid-attestation result with their cause.
    if (
      cause instanceof ElizaError &&
      cause.code === "AGENT_SNAPSHOT_SOURCE_ATTESTATION_INVALID"
    ) {
      throw cause;
    }
    throw new ElizaError("Snapshot source attestation is malformed", {
      cause,
      code: "AGENT_SNAPSHOT_SOURCE_ATTESTATION_INVALID",
      severity: "fatal",
    });
  }
}

export function verifyAgentSnapshotSourceAttestation(
  binding: AgentSnapshotUpgradeBinding,
  attestation: AgentSnapshotSourceAttestation | null,
): void {
  if (!attestation) {
    throw attestationError(
      "This runtime has no provider-owned snapshot source attestation",
      "AGENT_SNAPSHOT_SOURCE_ATTESTATION_MISSING",
    );
  }
  const requested: AgentSnapshotSourceAttestation = {
    sourceEnvironmentRevision: binding.sourceEnvironmentRevision,
    sourceImageDigest: binding.sourceImageDigest,
    sourceSandboxId: binding.sourceSandboxId,
  };
  if (stableJson(requested) !== stableJson(attestation)) {
    throw attestationError(
      "Snapshot request does not match this source placement",
      "AGENT_SNAPSHOT_SOURCE_ATTESTATION_MISMATCH",
    );
  }
}
