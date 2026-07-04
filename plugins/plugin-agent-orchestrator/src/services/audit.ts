/**
 * Append-only NDJSON audit log for orchestrator spawn / send / stop / cancel
 * decisions, emitted as `TASK_AUDIT` runtime events and persisted to disk. The
 * log self-rotates once it crosses a byte cap so a long-lived runtime cannot
 * grow it unbounded.
 */
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";

// Rotate the NDJSON audit log when it crosses this byte threshold. Without a
// cap, a long-lived runtime appends one line per spawn/send/cancel forever and
// the file grows unbounded — over time filling the user's disk. 10 MiB keeps a
// useful tail (~50k events) while bounding worst-case footprint at 20 MiB
// (current + .1 rolled).
const AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024;

export const TASK_AUDIT_EVENT = "TASK_AUDIT";

export type TaskAuditAction =
  | "spawn_agent"
  | "send_agent"
  | "stop_agent"
  | "cancel_agent";

export interface TaskAuditPayload {
  action: TaskAuditAction;
  outcome: "allowed" | "forbidden" | "error";
  entityId?: string;
  sessionId?: string;
  agentType?: string;
  workdir?: string;
  source?: string;
  reason?: string;
  ts: string;
}

export async function emitTaskAudit(
  runtime: IAgentRuntime,
  payload: Omit<TaskAuditPayload, "ts">,
): Promise<void> {
  // The extra fields ride through the typed `EventPayload` overload via the
  // intermediate variable (object-literal excess-property checks don't apply
  // to variables); the listener reads them in index.ts.
  const envelope = {
    runtime,
    ...payload,
    ts: new Date().toISOString(),
  };
  try {
    await runtime.emitEvent(TASK_AUDIT_EVENT, envelope);
  } catch {
    // best-effort: audit emission must never break the action it audits
  }
}

export function defaultAuditLogPath(): string {
  return join(homedir(), ".eliza", "plugin-acp", "audit.ndjson");
}

export async function appendAuditLine(
  path: string,
  payload: TaskAuditPayload,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rotateIfTooLarge(path);
  await appendFile(path, `${JSON.stringify(payload)}\n`, "utf8");
}

async function rotateIfTooLarge(path: string): Promise<void> {
  let size: number;
  try {
    const st = await stat(path);
    size = st.size;
  } catch {
    return; // file doesn't exist yet — first append creates it
  }
  if (size < AUDIT_LOG_MAX_BYTES) return;
  try {
    // Single-generation rotation: overwrite `.1` so we never accumulate more
    // than two files. Anyone needing deeper history can ship logs elsewhere.
    await rename(path, `${path}.1`);
  } catch {
    // best-effort: if rotation fails we still append; growing past the cap
    // is preferable to losing audit entries entirely.
  }
}
