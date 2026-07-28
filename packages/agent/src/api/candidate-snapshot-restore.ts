/**
 * Shared HTTP handler for the one provider-bound schema-v2 restore operation.
 * Both the full API host and the restore-validation process use this boundary,
 * keeping receipt, replay, header, and transfer validation identical.
 */
import type http from "node:http";
import { ElizaError, sendJson } from "@elizaos/core";
import type { AgentSnapshotUpgradeBinding } from "../services/agent-backup.ts";
import {
  beginCandidateSnapshotRestore,
  commitCandidateSnapshotRestore,
  verifyCandidateSnapshotRestoreHeaders,
  verifyCandidateSnapshotRestoreReplay,
} from "../services/agent-snapshot-restore-binding.ts";
import {
  type AgentSnapshotRestoreRuntime,
  restoreAgentSnapshotStream,
  validateAgentSnapshotStream,
} from "../services/agent-snapshot-stream.ts";
import {
  AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
  AGENT_SNAPSHOT_STREAM_TRANSFER,
} from "../services/agent-snapshot-stream-protocol.ts";

export function snapshotProtocolStatus(error: unknown): number {
  if (
    error instanceof ElizaError &&
    (error.code === "AGENT_SNAPSHOT_RECEIPT_CONFLICT" ||
      error.code === "AGENT_SNAPSHOT_SOURCE_ATTESTATION_MISMATCH" ||
      error.code === "AGENT_SNAPSHOT_RESTORE_INDETERMINATE" ||
      error.code === "AGENT_SNAPSHOT_RESTORE_NOT_ENABLED")
  ) {
    return 409;
  }
  if (
    error instanceof ElizaError &&
    (error.code === "AGENT_SNAPSHOT_MUTATION_ADMISSION_CLOSED" ||
      error.code === "AGENT_SNAPSHOT_CAPTURE_ALREADY_STARTED" ||
      error.code === "AGENT_SNAPSHOT_DEVICE_BRIDGE_ACTIVE" ||
      error.code === "AGENT_SNAPSHOT_DEVICE_BRIDGE_GUARD_UNAVAILABLE")
  ) {
    return 503;
  }
  return error instanceof ElizaError &&
    (error.code === "AGENT_SNAPSHOT_STREAM_INVALID" ||
      error.code === "AGENT_SNAPSHOT_REQUEST_INVALID" ||
      error.code === "AGENT_SNAPSHOT_BINDING_INVALID" ||
      error.code === "AGENT_SNAPSHOT_RECEIPT_INVALID")
    ? 400
    : 500;
}

function assertChunkedRestoreRequest(
  req: http.IncomingMessage,
  url: URL,
): void {
  const queryKeys = [...url.searchParams.keys()];
  const transfers = url.searchParams.getAll("transfer");
  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "transfer" ||
    transfers.length !== 1 ||
    transfers[0] !== AGENT_SNAPSHOT_STREAM_TRANSFER
  ) {
    throw new ElizaError("Unsupported snapshot restore transfer", {
      code: "AGENT_SNAPSHOT_STREAM_INVALID",
      severity: "fatal",
    });
  }
  if (req.headers["content-type"] !== AGENT_SNAPSHOT_STREAM_CONTENT_TYPE) {
    throw new ElizaError(
      `Chunked restore requires Content-Type ${AGENT_SNAPSHOT_STREAM_CONTENT_TYPE}`,
      {
        code: "AGENT_SNAPSHOT_STREAM_INVALID",
        severity: "fatal",
      },
    );
  }
}

export async function handleCandidateSnapshotRestore(args: {
  binding: AgentSnapshotUpgradeBinding;
  onApplyStarted?: () => void;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: AgentSnapshotRestoreRuntime;
  url: URL;
}): Promise<void> {
  const { binding, onApplyStarted, req, res, runtime, url } = args;
  assertChunkedRestoreRequest(req, url);
  verifyCandidateSnapshotRestoreHeaders(req.headers, binding);
  const committed = await beginCandidateSnapshotRestore(binding);
  if (committed) {
    const replayed = await validateAgentSnapshotStream(runtime, req, binding);
    verifyCandidateSnapshotRestoreReplay(committed, replayed);
    sendJson(res, committed);
    return;
  }
  onApplyStarted?.();
  const streamResult = await restoreAgentSnapshotStream(runtime, req, binding);
  sendJson(res, await commitCandidateSnapshotRestore(binding, streamResult));
}
