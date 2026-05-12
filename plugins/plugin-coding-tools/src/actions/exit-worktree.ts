import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readBoolParam,
  successActionResult,
} from "../lib/format.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const execFileAsync = promisify(execFile);

export async function exitWorktreeHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId =
    message.roomId !== undefined && message.roomId !== null
      ? String(message.roomId)
      : undefined;
  if (!conversationId) {
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  }

  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
    typeof SessionCwdService
  > | null;
  if (!sandbox || !session) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  }

  const cleanup = readBoolParam(options, "cleanup") ?? false;

  const popped = session.popWorktree(conversationId);
  if (!popped) {
    return failureToActionResult({
      reason: "invalid_param",
      message: "no worktree to exit",
    });
  }

  sandbox.removeRoot(conversationId, popped.entered);

  let cleaned = false;
  if (cleanup) {
    try {
      const timeoutMs = 30_000;
      await execFileAsync(
        "git",
        ["worktree", "remove", "--force", popped.entered],
        {
          cwd: popped.previousCwd,
          timeout: timeoutMs,
        },
      );
      cleaned = true;
    } catch (err) {
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: unknown }).stderr ?? "")
          : "";
      const msg = err instanceof Error ? err.message : String(err);
      return failureToActionResult(
        {
          reason: "io_error",
          message: stderr
            ? `git worktree remove failed: ${stderr.trim()}`
            : `git worktree remove failed: ${msg}`,
        },
        {
          exited: popped.entered,
          restoredTo: popped.previousCwd,
          cleaned: false,
        },
      );
    }
  }

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} WORKTREE action=exit from ${popped.entered} -> ${popped.previousCwd} cleaned=${cleaned}`,
  );

  const maxActionResultBytes = 2000;
  const text = (
    cleaned
      ? `Exited and removed worktree ${popped.entered}; cwd -> ${popped.previousCwd}`
      : `Exited worktree ${popped.entered}; cwd -> ${popped.previousCwd}`
  ).slice(0, maxActionResultBytes);
  if (callback) await callback({ text, source: "coding-tools" });

  return successActionResult(text, {
    exited: popped.entered,
    restoredTo: popped.previousCwd,
    cleaned,
  });
}
