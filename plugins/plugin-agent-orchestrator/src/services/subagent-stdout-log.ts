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
 * Rotation is non-destructive: when the active file crosses the size threshold
 * it is renamed to the next `.<n>` generation — never overwriting an earlier
 * one — and the reader spans every generation in order, so chunk indices are
 * stable global offsets and the canonical record stays complete for the
 * `acpx-session-output:<sessionId>` continuation contract. Provider
 * credentials are masked at write time (`redactSensitiveText`) so this
 * persisted file — which outlives the session — can never leak the model key
 * the sub-agent echoed to stdout.
 */
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  isTrajectoryRecordingEnabled,
  redactSensitiveText,
  resolveTrajectoryDir,
} from "@elizaos/core";

// Rotate the per-session stdout log when the ACTIVE file crosses this byte
// threshold. Rotation only splits the stream into generation files (`.1`,
// `.2`, ...) — it never deletes or overwrites one, because this log is the
// durable ground-truth record the session-output projections resolve against
// (prompt-integrity: the canonical record must stay complete). Retention of
// old generations is a deployment concern (external cleanup / log shipper),
// not this module's.
const STDOUT_LOG_MAX_BYTES = 10 * 1024 * 1024;

// Reader window bound (chunks per call). A larger caller `limit` is clamped;
// the clamp is REPORTED through the returned window's `limit` echo plus its
// `hasMore` flag, never applied silently.
const MAX_READ_CHUNKS = 10_000;

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
  // One JSON object per line: ts + the chunk. Kept verbatim (not line-split) to
  // preserve the exact stream the CLI agent produced, EXCEPT that provider
  // credentials are masked first: sub-agent stdout regularly echoes the model
  // key / Bearer token used, and this file outlives the session, so a raw secret
  // here would be a durable on-disk leak. redactSensitiveText is core's canonical
  // value-shape redactor (security/redact.ts) — the same pattern set the log sink
  // and runtime.redactSecrets apply, so a leaked key shape is masked everywhere.
  const record = JSON.stringify({
    ts: new Date().toISOString(),
    text: redactSensitiveText(text),
  });
  await appendFile(path, `${record}\n`, "utf8");
  return path;
}

/** One decoded chunk window read back from the durable log. */
export interface SubagentStdoutWindow {
  /** Concatenated chunk text for the requested window. */
  text: string;
  /** Zero-based GLOBAL index of the first chunk in the window. Stable across
   *  rotation: generations are spanned oldest-first, so an offset handed to a
   *  continuation call keeps meaning the same chunk. */
  offset: number;
  /** Effective chunk limit applied to this window. Echoed so a caller whose
   *  requested limit was clamped (see MAX_READ_CHUNKS) sees the clamp
   *  explicitly instead of a silently shorter window. */
  limit: number;
  /** Total chunks across every generation plus the active file. */
  totalChunks: number;
  /** True when chunks exist after the window (continuation available). */
  hasMore: boolean;
  /** True when rotated `.<n>` generations exist. Informational only — the
   *  reader includes every generation, so nothing is missing from the view. */
  rotated: boolean;
}

/**
 * Read a window of the durable per-session stdout log — the continuation
 * resolver for `acpx-session-output:<sessionId>` content references. Chunk
 * indexed (one NDJSON record per captured chunk) across ALL generations plus
 * the active file; a negative `offset` counts from the end (tail semantics).
 * Returns undefined when no log exists (recording disabled, or the session
 * never wrote output).
 */
export async function readSubagentStdout(
  sessionId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<SubagentStdoutWindow | undefined> {
  const path = subagentStdoutLogPath(sessionId);
  const generations = await listGenerations(path);
  const sources: string[] = [];
  for (const generation of generations) {
    const raw = await readFile(generation.path, "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        // error-policy:J3 a generation removed between listing and reading is
        // an explicit empty source; any other read failure is a real fault.
        if (err?.code === "ENOENT") return undefined;
        throw err;
      },
    );
    if (raw !== undefined) sources.push(raw);
  }
  const active = await readFile(path, "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      // error-policy:J3 ENOENT is the explicit "no active log" signal; any
      // other read failure is a real fault.
      if (err?.code === "ENOENT") return undefined;
      throw err;
    },
  );
  if (active !== undefined) sources.push(active);
  if (sources.length === 0) return undefined;
  const chunks: string[] = [];
  for (const raw of sources) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { text?: unknown };
        if (typeof record.text === "string") chunks.push(record.text);
      } catch {
        // error-policy:J3 a torn tail line (crash mid-append) is expected in an
        // append-only log; skip it rather than fail the whole read.
      }
    }
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_READ_CHUNKS));
  const requested = opts.offset ?? -limit;
  const start =
    requested < 0
      ? Math.max(0, chunks.length + requested)
      : Math.min(requested, chunks.length);
  const window = chunks.slice(start, start + limit);
  return {
    text: window.join(""),
    offset: start,
    limit,
    totalChunks: chunks.length,
    hasMore: start + window.length < chunks.length,
    rotated: generations.length > 0,
  };
}

// A session id flows in from ACP and could in principle contain path separators;
// keep the filename inside stdoutLogDir() by stripping anything but the safe set.
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Rotated generation files for a session log, oldest first (`.1`, `.2`, ...). */
async function listGenerations(
  path: string,
): Promise<Array<{ path: string; generation: number }>> {
  const dir = dirname(path);
  const base = basename(path);
  const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    // error-policy:J3 a missing log dir is the explicit "no generations yet"
    // result; any other listing failure is a real fault.
    if (err?.code === "ENOENT") return [] as string[];
    throw err;
  });
  return entries
    .filter((name) => name.startsWith(`${base}.`))
    .map((name) => ({
      path: join(dir, name),
      generation: Number.parseInt(name.slice(base.length + 1), 10),
    }))
    .filter(
      (entry) => Number.isInteger(entry.generation) && entry.generation > 0,
    )
    .sort((a, b) => a.generation - b.generation);
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
  // Non-destructive rotation: rename the active file to the NEXT generation
  // index — earlier generations are never overwritten, so the ground-truth
  // transcript that acpx-session-output references resolve against stays
  // complete. A rename failure (e.g. disk full) is NOT swallowed — it
  // propagates to appendSubagentStdout and the tee's reportError so the fault
  // is observable rather than silently dropping the ground-truth stdout.
  const generations = await listGenerations(path);
  const lastGeneration =
    generations.length > 0 ? generations[generations.length - 1].generation : 0;
  await rename(path, `${path}.${lastGeneration + 1}`);
}
