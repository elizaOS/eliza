import { throwGitError } from "./errors.ts";
import { GitOperationHistory } from "./operation-history.ts";
import type { GitOperation } from "./protocol.ts";

export type GitRunInput = {
  name: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type GitRunOutput = {
  operation: GitOperation;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
};

const DEFAULT_TIMEOUT_MS = 120_000;

export class GitCommandRunner {
  readonly history: GitOperationHistory;
  private readonly timeoutMs: number;

  constructor(
    options: { env?: NodeJS.ProcessEnv; history?: GitOperationHistory } = {},
  ) {
    const env = options.env ?? process.env;
    this.history = options.history ?? new GitOperationHistory({ env });
    this.timeoutMs = parsePositiveInt(
      env.ELIZA_GIT_COMMAND_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
  }

  async run(input: GitRunInput): Promise<GitRunOutput> {
    const cwd = input.cwd?.trim() || defaultCwd();
    const command = ["git", ...input.args];
    const operation = this.history.start(input.name, cwd, command);
    let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      process = Bun.spawn(command, {
        cwd,
        env: processEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (error) {
      const message = errorMessage(error);
      const failed = this.history.fail(operation.id, message);
      throwGitError({
        code:
          input.args[0] === "--version"
            ? "GIT_NOT_AVAILABLE"
            : "GIT_COMMAND_FAILED",
        message,
        cwd,
        command,
        details: { operation: failed },
      });
    }

    const timeoutMs = normalizeTimeout(input.timeoutMs, this.timeoutMs);
    const timeout = setTimeout(() => process.kill("SIGKILL"), timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      streamToString(process.stdout),
      streamToString(process.stderr),
      process.exited,
    ]).finally(() => clearTimeout(timeout));

    if (exitCode !== 0) {
      const message =
        stderr.trim() || stdout.trim() || `git exited with ${exitCode}`;
      const failed = this.history.fail(
        operation.id,
        message,
        stdout,
        stderr,
        exitCode,
        null,
      );
      throwGitError({
        code:
          input.args[0] === "--version"
            ? "GIT_NOT_AVAILABLE"
            : "GIT_COMMAND_FAILED",
        message,
        cwd,
        command,
        status: exitCode,
        stderr,
        details: { operation: failed },
      });
    }

    const completed = this.history.complete(
      operation.id,
      stdout,
      stderr,
      exitCode,
      null,
    );
    return {
      operation: completed,
      stdout,
      stderr,
      exitCode,
      signal: null,
    };
  }
}

export function defaultCwd(): string {
  return (
    process.env.ELIZA_REPO_DIR ?? process.env.ELIZA_REPO_DIR ?? process.cwd()
  );
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

async function streamToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    output += decoder.decode(result.value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Git command failed.";
}
