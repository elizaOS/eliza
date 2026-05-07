import * as path from "node:path";
import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
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
  capabilityDescription = "Per-conversation working directory for coding tools.";

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
