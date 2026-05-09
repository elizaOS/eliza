import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  type Action,
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
  CODING_TOOLS_CONTEXTS,
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

export const enterWorktreeAction: Action = {
  name: "ENTER_WORKTREE",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["GIT_WORKTREE_ADD", "ADD_WORKTREE", "OPEN_WORKTREE"],
  description:
    "Create a git worktree for the current repo and switch the session into it. The new worktree path becomes the session cwd and a sandbox root, so subsequent file operations land there until EXIT_WORKTREE pops it. Use to isolate a parallel branch of work without disturbing the main checkout.",
  descriptionCompressed:
    "Create and switch into a git worktree for parallel work.",
  parameters: [
    {
      name: "name",
      description:
        "Optional worktree branch/dir name. Defaults to a random auto-* identifier.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "path",
      description:
        "Optional absolute worktree directory. Must lie within sandbox roots. Defaults to a per-call directory under the OS temp dir.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "base",
      description: "Optional base ref for the new worktree (default HEAD).",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    return Boolean(
      runtime.getService(SANDBOX_SERVICE) &&
        runtime.getService(SESSION_CWD_SERVICE),
    );
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

    const name = readStringParam(options, "name") ?? generateWorktreeName();
    const explicitPath = readStringParam(options, "path");
    const base = readStringParam(options, "base") ?? "HEAD";

    let worktreePath: string;
    if (explicitPath) {
      const validation = await sandbox.validatePath(
        conversationId,
        explicitPath,
      );
      if (!validation.ok) {
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
  },
};
