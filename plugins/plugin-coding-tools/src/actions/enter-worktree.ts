import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

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
import { runGitCommand } from "../lib/run-git-command.js";
import type { SandboxService } from "../services/sandbox-service.js";
import type { SessionCwdService } from "../services/session-cwd-service.js";
import {
  CODING_TOOLS_LOG_PREFIX,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";

function generateWorktreeName(): string {
  return `auto-${crypto.randomBytes(4).toString("hex")}`;
}

function generateWorktreePath(name: string): string {
  return path.join(
    os.tmpdir(),
    `eliza-worktree-${name}-${crypto.randomBytes(3).toString("hex")}`,
  );
}

function conversationIdFromMessage(message: Memory): string | undefined {
  return message.roomId !== undefined && message.roomId !== null
    ? String(message.roomId)
    : undefined;
}

function codingServices(runtime: IAgentRuntime): {
  sandbox: InstanceType<typeof SandboxService>;
  session: InstanceType<typeof SessionCwdService>;
} | null {
  const sandbox = runtime.getService(SANDBOX_SERVICE) as InstanceType<
    typeof SandboxService
  > | null;
  const session = runtime.getService(SESSION_CWD_SERVICE) as InstanceType<
    typeof SessionCwdService
  > | null;
  return sandbox && session ? { sandbox, session } : null;
}

async function resolveWorktreePath(params: {
  sandbox: InstanceType<typeof SandboxService>;
  conversationId: string;
  explicitPath: string | undefined;
  name: string;
}): Promise<
  | { ok: true; worktreePath: string }
  | { ok: false; reason: "path_blocked" | "invalid_param"; message: string }
> {
  if (!params.explicitPath) {
    return {
      ok: true,
      worktreePath: path.resolve(generateWorktreePath(params.name)),
    };
  }
  const validation = await params.sandbox.validatePath(
    params.conversationId,
    params.explicitPath,
  );
  if (validation.ok) return { ok: true, worktreePath: validation.resolved };
  return {
    ok: false,
    reason: validation.reason === "blocked" ? "path_blocked" : "invalid_param",
    message: validation.message,
  };
}

function gitErrorMessage(err: unknown): string {
  const stderr =
    err && typeof err === "object" && "stderr" in err
      ? String((err as { stderr: unknown }).stderr ?? "")
      : "";
  const message = err instanceof Error ? err.message : String(err);
  return stderr.trim() || message;
}

export async function enterWorktreeHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const conversationId = conversationIdFromMessage(message);
  if (!conversationId) {
    return failureToActionResult({
      reason: "missing_param",
      message: "no roomId",
    });
  }

  const services = codingServices(runtime);
  if (!services) {
    return failureToActionResult({
      reason: "internal",
      message: "coding-tools services unavailable",
    });
  }

  const name = readStringParam(options, "name") ?? generateWorktreeName();
  const explicitPath = readStringParam(options, "path");
  const base = readStringParam(options, "base") ?? "HEAD";

  const resolved = await resolveWorktreePath({
    sandbox: services.sandbox,
    conversationId,
    explicitPath,
    name,
  });
  if (!resolved.ok) {
    return failureToActionResult({
      reason: resolved.reason,
      message: resolved.message,
    });
  }
  const worktreePath = resolved.worktreePath;

  const cwd = services.session.getCwd(conversationId);

  try {
    const timeoutMs = 30_000;
    await runGitCommand(runtime, {
      cwd,
      args: ["worktree", "add", "-b", name, worktreePath, base],
      timeoutMs,
    });
  } catch (err) {
    return failureToActionResult({
      reason: "io_error",
      message: `git worktree add failed: ${gitErrorMessage(err)}`,
    });
  }

  services.sandbox.addRoot(conversationId, worktreePath);
  services.session.pushWorktree(conversationId, worktreePath);

  coreLogger.debug(
    `${CODING_TOOLS_LOG_PREFIX} WORKTREE action=enter branch=${name} path=${worktreePath} base=${base}`,
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
