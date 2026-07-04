/**
 * `SessionCwdService` (serviceType `CODING_TOOLS_SESSION_CWD`): the per-conversation
 * working directory, defaulting to `process.cwd()`. Glob/grep/ls/shell use it when
 * no explicit path is given; the worktree actions push/pop it as a stack when
 * entering and leaving worktrees.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  logger as coreLogger,
  type IAgentRuntime,
  Service,
} from "@elizaos/core";
import { CODING_TOOLS_LOG_PREFIX, SESSION_CWD_SERVICE } from "../types.js";

/**
 * Per-conversation working directory. The "session cwd" is the default
 * starting point for tools that take an optional `path` (Glob/Grep/LS) or
 * `cwd` (Bash) parameter.
 *
 * - Default for a fresh conversation = `process.cwd()`.
 * - EnterWorktree sets it to the new worktree root.
 * - ExitWorktree restores it.
 * - Bash invocations inherit it but cannot mutate it (changes inside the
 *   command don't persist, matching Claude's semantics).
 *
 * Note: tools requiring `file_path` (Read/Write/Edit/NotebookEdit) ignore
 * this and demand absolute paths.
 */
export class SessionCwdService extends Service {
  static serviceType = SESSION_CWD_SERVICE;
  capabilityDescription =
    "Per-conversation working directory for coding tools.";

  private cwdByConversation = new Map<string, string>();
  private frames = new Map<
    string,
    Array<{ previousCwd: string; entered: string }>
  >();

  static async start(runtime: IAgentRuntime): Promise<SessionCwdService> {
    const svc = new SessionCwdService(runtime);
    coreLogger.debug(`${CODING_TOOLS_LOG_PREFIX} SessionCwdService started`);
    return svc;
  }

  async stop(): Promise<void> {
    this.cwdByConversation.clear();
    this.frames.clear();
  }

  defaultCwd(): string {
    return path.resolve(process.cwd());
  }

  getCwd(conversationId: string | undefined): string {
    if (!conversationId) return this.defaultCwd();
    return this.cwdByConversation.get(conversationId) ?? this.defaultCwd();
  }

  async getExistingCwd(conversationId: string | undefined): Promise<{
    cwd: string;
    previousCwd?: string;
    reset: boolean;
  }> {
    const cwd = this.getCwd(conversationId);
    if (await isDirectory(cwd)) {
      return { cwd, reset: false };
    }
    const fallback = this.defaultCwd();
    if (conversationId) {
      this.cwdByConversation.set(conversationId, fallback);
    }
    return { cwd: fallback, previousCwd: cwd, reset: true };
  }

  setCwd(conversationId: string, absPath: string): void {
    this.cwdByConversation.set(conversationId, path.resolve(absPath));
  }

  pushWorktree(conversationId: string, absPath: string): string {
    const resolved = path.resolve(absPath);
    const list = this.frames.get(conversationId) ?? [];
    list.push({ previousCwd: this.getCwd(conversationId), entered: resolved });
    this.frames.set(conversationId, list);
    this.cwdByConversation.set(conversationId, resolved);
    return resolved;
  }

  popWorktree(
    conversationId: string,
  ): { previousCwd: string; entered: string } | undefined {
    const list = this.frames.get(conversationId);
    if (!list || list.length === 0) return undefined;
    const frame = list.pop();
    if (!frame) return undefined;
    if (list.length === 0) this.frames.delete(conversationId);
    else this.frames.set(conversationId, list);
    this.cwdByConversation.set(conversationId, frame.previousCwd);
    return { previousCwd: frame.previousCwd, entered: frame.entered };
  }
}

async function isDirectory(absPath: string): Promise<boolean> {
  try {
    return (await fs.stat(absPath)).isDirectory();
  } catch {
    // error-policy:J3 existence/type probe; a stat failure (ENOENT) means the
    // path is absent — false is the expected-miss signal.
    return false;
  }
}
