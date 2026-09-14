/**
 * Append-only audit logging for vault operations.
 *
 * Records operation metadata and key names to JSONL while never persisting
 * secret values in the audit trail.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { appendJsonlRecordAsync } from "@elizaos/shared";
import type { AuditRecord, VaultLogger } from "./types.js";

/**
 * Append-only JSONL audit log. One line per vault operation. Records
 * keys, never values.
 */
export class AuditLog {
  constructor(
    private readonly path: string,
    private readonly logger?: VaultLogger,
  ) {}

  async record(
    entry: Omit<AuditRecord, "ts"> & { ts?: number },
  ): Promise<void> {
    const record: AuditRecord = { ts: entry.ts ?? Date.now(), ...entry };
    try {
      await fs.mkdir(dirname(this.path), { recursive: true });
      // Isolates a line torn by an interrupted earlier append so the next
      // operation still lands on a readable JSONL line.
      await appendJsonlRecordAsync(this.path, record, { mode: 0o600 });
    } catch (err) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — vault access without
      // an audit trail is unsafe, so a failed audit append is warned AND
      // rethrown, failing the caller's privileged operation closed rather than
      // proceeding un-audited.
      this.logger?.warn(
        `[vault] failed to append audit record to ${this.path}`,
        err,
      );
      throw err;
    }
  }
}
