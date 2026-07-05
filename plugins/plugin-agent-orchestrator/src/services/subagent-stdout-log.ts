/**
 * Append-only NDJSON persistence for raw sub-agent stdout. The ACP stream from
 * a spawned coding agent is the ground truth of what the CLI agent actually did,
 * but AcpService keeps it only in an in-memory `outputBuffers` tail that is
 * deleted when the session closes (acp-service.ts) — so after a task ends the
 * deepest trace is gone. This module tees that stream to a per-session file
 * under the trajectory dir so it survives session close and is discoverable
 * (the path is referenced from the task document via the `task_complete` event).
 *
 * Gated by the SAME policy as the trajectory recorder
 * (`isTrajectoryRecordingEnabled`): when recording is off, nothing is written.
 * Rotation mirrors the orchestrator audit log (single-generation `.1`) so a
 * long-lived, chatty session cannot grow the file unbounded.
 */
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isTrajectoryRecordingEnabled,
  resolveTrajectoryDir,
} from "@elizaos/core";

// Rotate the per-session stdout log when it crosses this byte threshold. Chosen
// to match the orchestrator audit log's cap (audit.ts:17): a sub-agent can emit
// megabytes of tool output over a long session, and without a cap the file
// grows unbounded. Single-generation rotation bounds the worst case at 2x.
const STDOUT_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Directory under the trajectory root that holds one NDJSON file per session. */
function stdoutLogDir(): string {
  return join(resolveTrajectoryDir(), "subagent-stdout");
}

/**
 * Absolute path of the append-only stdout log for a session. Stable across the
 * session's lifetime so the tee (live) and the task-document reference (at
 * completion) agree on one file.
 */
export function subagentStdoutLogPath(sessionId: string): string {
  return join(stdoutLogDir(), `${sanitizeSessionId(sessionId)}.ndjson`);
}

export function isSubagentStdoutLoggingEnabled(): boolean {
  return isTrajectoryRecordingEnabled();
}

/**
 * Append one raw-stdout chunk to the session's log as an NDJSON record. No-op
 * when trajectory recording is disabled — the caller stays free of gate logic.
 * Returns the file path when a write happened, otherwise `undefined`, so the
 * caller can reference it from the task document only when it actually exists.
 */
export async function appendSubagentStdout(
  sessionId: string,
  text: string,
): Promise<string | undefined> {
  if (!isTrajectoryRecordingEnabled()) return undefined;
  const path = subagentStdoutLogPath(sessionId);
  await mkdir(stdoutLogDir(), { recursive: true });
  await rotateIfTooLarge(path);
  // One JSON object per line: ts + the raw chunk. Keeping the chunk verbatim
  // (not line-split) preserves the exact stream the CLI agent produced.
  const record = JSON.stringify({ ts: new Date().toISOString(), text });
  await appendFile(path, `${record}\n`, "utf8");
  return path;
}

// A session id flows in from ACP and could in principle contain path separators;
// keep the filename inside stdoutLogDir() by stripping anything but the safe set.
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function rotateIfTooLarge(path: string): Promise<void> {
  const st = await stat(path).catch((err: NodeJS.ErrnoException) => {
    // error-policy:J3 a missing file is the explicit "nothing to rotate" signal
    // (ENOENT → first append will create it). Any other stat failure is a real
    // fault and must surface, so only ENOENT is swallowed here.
    if (err?.code === "ENOENT") return undefined;
    throw err;
  });
  if (!st || st.size < STDOUT_LOG_MAX_BYTES) return;
  // Single-generation rotation: overwrite `.1` so we never keep more than two
  // files. Deeper history belongs in an external log shipper, not here. A rename
  // failure (e.g. disk full) is NOT swallowed — it propagates to appendSubagentStdout
  // and the tee's reportError so the fault is observable rather than silently
  // dropping the ground-truth stdout.
  await rename(path, `${path}.1`);
}
