/** Defines sandbox snapshot outcomes and explicit transport failure sentinels shared by backup capture, restore, and lifecycle callers. */
import { type AgentSandboxBackup } from "../../../../db/repositories/agent-sandboxes";

export interface SnapshotResult {
  success: boolean;
  backup?: AgentSandboxBackup;
  error?: string;
  retryable?: boolean;
}

/**
 * Outcome of carrying an agent's state onto a replacement container.
 *
 * `capture-unsupported` is not a failure to retry: the running image has no
 * snapshot endpoint, so the agent cannot be relocated at all and must be left
 * where it is. Every other reason describes a move that did not happen and can
 * be attempted again.
 */
export type StateTransferOutcome =
  | { transferred: true; snapshotId: string; sizeBytes: number }
  | {
      transferred: false;
      reason: "capture-unsupported" | "capture-failed" | "reconstruct-failed" | "push-failed";
      detail: string;
    };

/**
 * Sentinel error for "the running agent image does not serve POST /api/snapshot".
 * The deployed elizaOS (V2) agent image binds its API to ELIZA_PORT/PORT and
 * does not expose the bridge `/api/snapshot` route — only the cloud-agent
 * template image (and the in-memory test double) do. A scheduled (auto) backup
 * against such an agent is a no-op, not a failure, so the snapshot job treats
 * this exactly like "Sandbox is not running": skip without burning retries.
 */
export const SNAPSHOT_ENDPOINT_UNSUPPORTED = "Snapshot endpoint not supported by agent image";

/**
 * Transient pre-stop snapshot failure (agent returned 503 because its PGlite
 * connection was closing while dumpDataDir() ran). Distinct from a hard 500 so
 * a state-preserving restart can defer rather than permanently refuse to stop
 * (2026-08-11 fleet incident: a 500 here wedged healthy agent restarts).
 */
export const SNAPSHOT_CAPTURE_TRANSIENT = "Snapshot capture temporarily unavailable";

export const AGENT_SNAPSHOT_CAPTURE_TRANSIENT_CODE = "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT";

export const MAX_BACKUPS = 10;

export const SNAPSHOT_FETCH_TIMEOUT_MS = 120_000;

export const SNAPSHOT_RESTORE_TIMEOUT_MS = 120_000;
