import * as fs from "node:fs/promises";
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import type { FileMeta } from "../types.js";
import { CODING_TOOLS_LOG_PREFIX, FILE_STATE_SERVICE } from "../types.js";

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

  async recordRead(conversationId: string, absPath: string): Promise<void> {
    const stat = await fs.stat(absPath);
    this.state.set(this.key(conversationId, absPath), {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readAt: Date.now(),
    });
  }

  async recordWrite(conversationId: string, absPath: string): Promise<void> {
    const stat = await fs.stat(absPath);
    this.state.set(this.key(conversationId, absPath), {
      path: absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      readAt: Date.now(),
    });
  }

  get(conversationId: string, absPath: string): FileMeta | undefined {
    return this.state.get(this.key(conversationId, absPath));
  }

  async assertWritable(
    conversationId: string,
    absPath: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "must_read_first" | "stale_read"; message: string }
  > {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absPath);
    } catch {
      // File doesn't exist — Write is allowed (creating new file). Edit must
      // separately verify existence.
      return { ok: true };
    }
    const meta = this.get(conversationId, absPath);
    if (!meta) {
      return {
        ok: false,
        reason: "must_read_first",
        message: `File ${absPath} exists but was not read in this session. Read it first.`,
      };
    }
    if (stat.mtimeMs !== meta.mtimeMs) {
      return {
        ok: false,
        reason: "stale_read",
        message: `File ${absPath} was modified externally since last read (mtime ${meta.mtimeMs} → ${stat.mtimeMs}). Re-read before writing.`,
      };
    }
    return { ok: true };
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
