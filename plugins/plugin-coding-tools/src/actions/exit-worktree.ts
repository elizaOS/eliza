import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger as coreLogger,
} from "@elizaos/core";

import { failureToActionResult, readBoolParam, successActionResult } from "../lib/format.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_CONTEXTS,
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

const execFileAsync = promisify(execFile);

export const exitWorktreeAction: Action = {
  name: "EXIT_WORKTREE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  similes: ["LEAVE_WORKTREE", "POP_WORKTREE", "GIT_WORKTREE_REMOVE"],
  description:
    "Pop the most recent ENTER_WORKTREE: restore the previous session cwd, drop the added sandbox root, and (with cleanup=true) run `git worktree remove --force` to delete the worktree directory.",
  descriptionCompressed:
    "Exit current worktree, restore previous cwd, optionally git worktree remove --force.",
  parameters: [
    {
      name: "cleanup",
      description: "If true, also `git worktree remove --force` the popped worktree directory.",
      required: false,
      schema: { type: "boolean" },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    const d = runtime.getSetting?.("CODING_TOOLS_DISABLE");
    if (d === true || d === "true" || d === "1") return false;
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
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
        await execFileAsync("git", ["worktree", "remove", "--force", popped.entered], {
          cwd: popped.previousCwd,
          timeout: timeoutMs,
        });
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
          { exited: popped.entered, restoredTo: popped.previousCwd, cleaned: false },
        );
      }
    }

    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} EXIT_WORKTREE from ${popped.entered} -> ${popped.previousCwd} cleaned=${cleaned}`,
    );

    const maxActionResultBytes = 2000;
    const text = (cleaned
      ? `Exited and removed worktree ${popped.entered}; cwd -> ${popped.previousCwd}`
      : `Exited worktree ${popped.entered}; cwd -> ${popped.previousCwd}`).slice(
      0,
      maxActionResultBytes,
    );
    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      exited: popped.entered,
      restoredTo: popped.previousCwd,
      cleaned,
    });
  },
};
