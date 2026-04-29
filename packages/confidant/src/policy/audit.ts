import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord, ConfidantLogger } from "../types.js";

/**
 * Append-only JSONL audit log. Every Confidant resolve produces one line;
 * permission denials produce one line; explicit grant changes produce one
 * line.
 *
 * The log records secret ids, never values. A leaked audit log reveals
 * which skills used which credential ids, but not the credentials themselves.
 *
 * Phase 0 has no rotation; phase 1 adds daily rotation to a dated suffix.
 */
export class AuditLog {
  constructor(
    private readonly path: string,
    private readonly logger?: ConfidantLogger,
  ) {}

  async record(entry: Omit<AuditRecord, "ts"> & { ts?: number }): Promise<void> {
    const record: AuditRecord = { ts: entry.ts ?? Date.now(), ...entry };
    const line = `${JSON.stringify(record)}\n`;
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.appendFile(this.path, line, { mode: 0o600 });
    } catch (err) {
      // Audit failure must not block the caller, but it must be visible —
      // a silently-broken audit log is the same as no audit log at all.
      this.logger?.warn(
        `[Confidant] failed to append audit record to ${this.path}`,
        err,
      );
    }
  }
}
