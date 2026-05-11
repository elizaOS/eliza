import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
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
  readStringParam,
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

function generateWorktreeName(): string {
  return `auto-${crypto.randomBytes(4).toString("hex")}`;
}

function generateWorktreePath(name: string): string {
  return path.join(
    os.tmpdir(),
    `eliza-worktree-${name}-${crypto.randomBytes(3).toString("hex")}`,
  );
}

export async function enterWorktreeHandler(
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

  const name = readStringParam(options, "name") ?? generateWorktreeName();
  const explicitPath = readStringParam(options, "path");
  const base = readStringParam(options, "base") ?? "HEAD";

  let worktreePath: string;
  if (explicitPath) {
    const validation = await sandbox.validatePath(
      conversationId,
      explicitPath,
    );
    if (validation.ok === false) {
      const reason =
        validation.reason === "blocked" ? "path_blocked" : "invalid_param";
      return failureToActionResult({ reason, message: validation.message });
    }
    worktreePath = validation.resolved;
  } else {
    worktreePath = path.resolve(generateWorktreePath(name));
  }

  const cwd = session.getCwd(conversationId);

  try {
    const timeoutMs = 30_000;
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", name, worktreePath, base],
      {
        cwd,
        timeout: timeoutMs,
      },
    );
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    const msg = err instanceof Error ? err.message : String(err);
    return failureToActionResult({
      reason: "io_error",
      message: stderr
        ? `git worktree add failed: ${stderr.trim()}`
        : `git worktree add failed: ${msg}`,
    });
  }

  sandbox.addRoot(conversationId, worktreePath);
  session.pushWorktree(conversationId, worktreePath);

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} ENTER_WORKTREE branch=${name} path=${worktreePath} base=${base}`,
  );

  const maxActionResultBytes = 2000;
  const text =
    `Entered worktree ${worktreePath} on branch ${name} (from ${base})`.slice(
      0,
      maxActionResultBytes,
    );
  if (callback) await callback({ text, source: "coding-tools" });

  return successActionResult(text, {
    worktreePath,
    branch: name,
    message: text,
  });
}
