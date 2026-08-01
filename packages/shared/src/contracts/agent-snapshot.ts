/**
 * Compatibility names for the canonical v1 backup limits. Cloud-agent bundles
 * consume this contract directly, while the rest of the repository imports
 * `agent-backup-limits`; both surfaces delegate to one source of truth so wire
 * acceptance, retention, and restore can never drift.
 */

import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  resolveRetainableAgentBackupBytes,
  SnapshotPayloadTooLargeError,
} from "../agent-backup-limits.js";

export const AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES =
  MAX_RESTORABLE_AGENT_BACKUP_BYTES;

/**
 * Observable size-only failure for a v1 snapshot that cannot be restored.
 * Payload contents and tenant identifiers are deliberately excluded.
 */
export class AgentSnapshotV1WireLimitError extends SnapshotPayloadTooLargeError {
  override readonly name = "AgentSnapshotV1WireLimitError";
  readonly receivedBytes: number;
  readonly maxBytes: number;

  constructor(receivedBytes: number, maxBytes: number) {
    super(receivedBytes, maxBytes);
    this.message =
      `Agent snapshot v1 payload exceeds the maximum restorable wire size ` +
      `(${receivedBytes} > ${maxBytes} bytes)`;
    this.receivedBytes = receivedBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Resolve an optional deployment-specific v1 limit without allowing an
 * operator override to exceed the protocol's universally restorable ceiling.
 * Only an absent or blank override defaults: a configured malformed value
 * fails fast so an operator typo cannot silently select an unintended budget.
 */
export function resolveAgentSnapshotV1MaxWireBytes(
  configuredBytes: string | undefined,
): number {
  return resolveRetainableAgentBackupBytes(configuredBytes);
}

/**
 * Enforce the v1 wire limit against an already-counted payload.
 */
export function assertAgentSnapshotV1WireByteLength(
  receivedBytes: number,
  maxBytes = AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
): void {
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) {
    throw new RangeError(
      "Agent snapshot v1 wire byte length must be a non-negative safe integer",
    );
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES
  ) {
    throw new RangeError(
      `Agent snapshot v1 wire limit must be between 1 and ` +
        `${AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES} bytes`,
    );
  }
  if (receivedBytes > maxBytes) {
    throw new AgentSnapshotV1WireLimitError(receivedBytes, maxBytes);
  }
}
