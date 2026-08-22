/**
 * `FileStateService` (serviceType `CODING_TOOLS_FILE_STATE`): tracks each file's
 * opaque revision per conversation at read time so continuation and mutation
 * handlers reject externally changed content instead of clobbering it.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import type { FileMeta } from "../types.js";
import { CODING_TOOLS_LOG_PREFIX, FILE_STATE_SERVICE } from "../types.js";

/** Produces the stable identity shared by paginated reads and mutation guards. */
export function fileRevision(
  stat: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
): string {
  return createHash("sha256")
    .update(
      `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    )
    .digest("hex");
}

/**
 * Tracks per-(conversation, file) read state. Mirrors Claude's `readFileState` —
 * the gate that lets WRITE/EDIT detect whether a file was modified externally
 * since the agent last read it. Without this the agent will overwrite human
 * changes silently.
 *
 * Keyed by `${conversationId}::${absolutePath}`. State lives in memory; on
 * runtime restart the agent must re-Read before Write/Edit.
 */
export class FileStateService extends Service {
  static serviceType = FILE_STATE_SERVICE;
  capabilityDescription =
    "Per-conversation file mtime tracking for safe Write/Edit operations.";

  private state = new Map<string, FileMeta>();

  static async start(runtime: IAgentRuntime): Promise<FileStateService> {
    const svc = new FileStateService(runtime);
    coreLogger.debug(`${CODING_TOOLS_LOG_PREFIX} FileStateService started`);
    return svc;
  }

  async stop(): Promise<void> {
    this.state.clear();
  }

  private key(conversationId: string, absPath: string): string {
    return `${conversationId}::${absPath}`;
  }

  async recordRead(
    conversationId: string,
    absPath: string,
    observed?: { mtimeMs: number; size: number; revision: string },
  ): Promise<void> {
    const stat = observed ?? (await fs.stat(absPath));
    this.state.set(this.key(conversationId, absPath), {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readAt: Date.now(),
      ...(observed ? { revision: observed.revision } : {}),
    });
  }

  async recordWrite(conversationId: string, absPath: string): Promise<void> {
    const stat = await fs.stat(absPath);
    this.state.set(this.key(conversationId, absPath), {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readAt: Date.now(),
      revision: fileRevision(stat),
    });
  }

  get(conversationId: string, absPath: string): FileMeta | undefined {
    return this.state.get(this.key(conversationId, absPath));
  }

  async assertWritable(
    conversationId: string,
    absPath: string,
  ): Promise<
    | { ok: true; exists: boolean }
    | { ok: false; reason: "must_read_first" | "stale_read"; message: string }
  > {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      // error-policy:J3 existence probe — any stat failure routes to the
      // create-new-file path (Write is allowed; Edit re-verifies existence
      // separately). A genuine permission error is not masked: the subsequent
      // fs.writeFile surfaces it to the caller as an `io_error` failure.
      return { ok: true, exists: false };
    }
    const meta = this.get(conversationId, absPath);
    if (!meta) {
      return {
        ok: false,
        reason: "must_read_first",
        message: `File ${absPath} exists but was not read in this session. Read it first.`,
      };
    }
    const changed = meta.revision
      ? fileRevision(stat) !== meta.revision
      : stat.mtimeMs !== meta.mtimeMs || stat.size !== meta.size;
    if (changed) {
      return {
        ok: false,
        reason: "stale_read",
        message: `File ${absPath} was modified externally since last read. Re-read before writing.`,
      };
    }
    return { ok: true, exists: true };
  }

  invalidate(conversationId: string, absPath: string): void {
    this.state.delete(this.key(conversationId, absPath));
  }

  clearConversation(conversationId: string): void {
    const prefix = `${conversationId}::`;
    for (const k of this.state.keys()) {
      if (k.startsWith(prefix)) this.state.delete(k);
    }
  }
}
