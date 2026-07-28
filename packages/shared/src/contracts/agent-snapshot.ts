/**
 * Version-one agent snapshot wire limits shared by every producer, transport,
 * verifier, and restore boundary. A deployment may lower the limit for a
 * constrained environment, but it may never raise it above the largest body
 * every v1 restore endpoint is guaranteed to accept.
 */

export const AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES = 128 * 1024 * 1024;

/**
 * Observable size-only failure for a v1 snapshot that cannot be restored.
 * Payload contents and tenant identifiers are deliberately excluded.
 */
export class AgentSnapshotV1WireLimitError extends Error {
  readonly receivedBytes: number;
  readonly maxBytes: number;

  constructor(receivedBytes: number, maxBytes: number) {
    super(
      `Agent snapshot v1 payload exceeds the maximum restorable wire size ` +
        `(${receivedBytes} > ${maxBytes} bytes)`,
    );
    this.name = "AgentSnapshotV1WireLimitError";
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
  if (configuredBytes === undefined || configuredBytes.trim() === "") {
    return AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES;
  }
  const trimmed = configuredBytes.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid snapshot retain budget ${JSON.stringify(configuredBytes)}: ` +
        "expected a positive integer count of bytes",
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid snapshot retain budget ${JSON.stringify(configuredBytes)}: ` +
        "expected a positive integer count of bytes",
    );
  }
  return Math.min(parsed, AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES);
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
