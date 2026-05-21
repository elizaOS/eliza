/**
 * PTY sub-agent session recording (SOC2 O-8).
 *
 * Persists a redacted transcript of every spawned session to
 * `~/.eliza/sub-agent-sessions/<session-id>/transcript.log` and emits an
 * `agent.session_record` audit event carrying the content hash + size
 * so the audit pipeline can correlate without storing prompt text.
 *
 * Retention: a background sweep deletes session directories older than
 * `RETENTION_DAYS` (default 30) on `prune()` invocation.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditDispatcher } from "@elizaos/security";

const SESSIONS_ROOT = process.env.ELIZA_SUB_AGENT_SESSIONS_DIR
  ? process.env.ELIZA_SUB_AGENT_SESSIONS_DIR
  : join(homedir(), ".eliza", "sub-agent-sessions");

const RETENTION_DAYS = Number.parseInt(
  process.env.ELIZA_SUB_AGENT_SESSION_RETENTION_DAYS ?? "30",
  10,
);

/**
 * Redaction patterns — strip the obvious credential shapes before we
 * write anything to disk. This is a coarse pass; combine with workspace
 * isolation rather than relying on it as the only line of defence.
 */
const REDACT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /[A-Za-z0-9_-]{20,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: "<EMAIL>" },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: "<EMAIL>" },
  { re: /sk-[A-Za-z0-9_-]{20,}/g, label: "<API_KEY>" },
  { re: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, label: "<GH_TOKEN>" },
  { re: /xox[bpars]-[A-Za-z0-9-]{10,}/g, label: "<SLACK_TOKEN>" },
  { re: /0x[a-fA-F0-9]{40}/g, label: "<ETH_ADDR>" },
  { re: /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, label: "<BTC_ADDR>" },
  { re: /\b\d{13,19}\b/g, label: "<CARD>" },
];

export function redactTranscriptLine(line: string): string {
  let out = line;
  for (const { re, label } of REDACT_PATTERNS) {
    out = out.replace(re, label);
  }
  return out;
}

export interface SessionRecorderOptions {
  sessionId: string;
  auditDispatcher?: AuditDispatcher;
  actorId?: string;
}

/**
 * Per-session transcript writer. Append lines via `record()`; call
 * `finalize()` on session terminate to emit the audit event.
 */
export class SessionRecorder {
  private readonly dir: string;
  private readonly path: string;
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private finalized = false;

  constructor(private readonly opts: SessionRecorderOptions) {
    this.dir = join(SESSIONS_ROOT, opts.sessionId);
    this.path = join(this.dir, "transcript.log");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, "", "utf8");
  }

  record(line: string): void {
    if (this.finalized) return;
    const safe = redactTranscriptLine(line);
    const withNl = safe.endsWith("\n") ? safe : `${safe}\n`;
    try {
      // appendFileSync semantics; small writes only.
      const buf = Buffer.from(withNl, "utf8");
      this.hash.update(buf);
      this.bytes += buf.byteLength;
      // Use appendFileSync via writeFileSync with { flag: 'a' }.
      writeFileSync(this.path, buf, { flag: "a" });
    } catch {
      // Disk errors must not crash the sub-agent.
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    const digest = this.hash.digest("hex");
    if (this.opts.auditDispatcher) {
      try {
        await this.opts.auditDispatcher.emit({
          actor: {
            type: this.opts.actorId ? "user" : "system",
            id: this.opts.actorId ?? "agent",
          },
          action: "agent.session_record",
          result: "success",
          resource: { type: "sub-agent.session", id: this.opts.sessionId },
          metadata: {
            session_id: this.opts.sessionId,
            transcript_hash: digest,
            transcript_bytes: this.bytes,
          },
        });
      } catch {
        // Audit must never throw out of session lifecycle.
      }
    }
  }
}

/**
 * Delete session directories older than `RETENTION_DAYS`. Safe to call
 * fire-and-forget at service start.
 */
export function pruneOldSessions(now: number = Date.now()): number {
  if (!existsSync(SESSIONS_ROOT)) return 0;
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(SESSIONS_ROOT, entry.name);
    try {
      const stat = statSync(dir);
      if (stat.mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Ignore individual prune errors.
    }
  }
  return removed;
}

export { SESSIONS_ROOT, RETENTION_DAYS };
