import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  CapabilityError,
  type GitOperation,
  getCapabilityRouter,
  type IAgentRuntime,
} from "@elizaos/core";

const execFileAsync = promisify(execFile);

export type RunGitCommandOptions = {
  cwd: string;
  args: string[];
  timeoutMs: number;
};

export type RunGitCommandResult = {
  routed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
};

export class GitCommandExecutionError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(message);
    this.name = "GitCommandExecutionError";
    this.stderr = stderr;
  }
}

export async function runGitCommand(
  runtime: IAgentRuntime,
  opts: RunGitCommandOptions,
): Promise<RunGitCommandResult> {
  const router = getCapabilityRouter(runtime);
  if (router) {
    try {
      const result = await router.git.commandRun({
        root: opts.cwd,
        args: opts.args,
      });
      return routedResult(result.operation);
    } catch (error) {
      if (
        error instanceof CapabilityError &&
        error.code === "CAPABILITY_UNAVAILABLE"
      ) {
        return runLocalGitCommand(opts);
      }
      throw error;
    }
  }

  return runLocalGitCommand(opts);
}

async function runLocalGitCommand(
  opts: RunGitCommandOptions,
): Promise<RunGitCommandResult> {
  const result = await execFileAsync("git", opts.args, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs,
  });
  return {
    routed: false,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: 0,
    signal: null,
  };
}

function routedResult(operation: GitOperation): RunGitCommandResult {
  const exitCode = operation.exitCode ?? null;
  if (operation.status === "failed" || (exitCode !== null && exitCode !== 0)) {
    throw new GitCommandExecutionError(
      operation.error ?? `git exited with status ${exitCode}`,
      operation.stderr,
    );
  }
  return {
    routed: true,
    stdout: operation.stdout,
    stderr: operation.stderr,
    exitCode,
    signal: operation.signal ?? null,
  };
}
