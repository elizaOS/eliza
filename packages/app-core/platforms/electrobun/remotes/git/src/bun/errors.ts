/** Implements Electrobun git remote errors ts boundaries for desktop app-core. */
import type { GitError, GitErrorCode } from "./protocol.ts";

export class GitException extends Error {
  readonly code: GitErrorCode;
  readonly cwd?: string;
  readonly command?: string[];
  readonly status?: number;
  readonly stderr?: string;
  readonly details?: unknown;

  constructor(input: GitError) {
    super(input.message);
    this.name = "GitException";
    this.code = input.code;
    this.cwd = input.cwd;
    this.command = input.command;
    this.status = input.status;
    this.stderr = input.stderr;
    this.details = input.details;
  }
}

export function createGitError(input: GitError): GitError {
  return {
    code: input.code,
    message: input.message,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

export function throwGitError(input: GitError): never {
  throw new GitException(createGitError(input));
}

export function isGitError(value: unknown): value is GitError {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && typeof record.message === "string";
}

export function serializeGitError(error: unknown): GitError {
  if (error instanceof GitException) {
    return createGitError({
      code: error.code,
      message: error.message,
      cwd: error.cwd,
      command: error.command,
      status: error.status,
      stderr: error.stderr,
      details: error.details,
    });
  }
  if (isGitError(error)) return createGitError(error);
  if (error instanceof Error) {
    return createGitError({
      code: "GIT_REQUEST_FAILED",
      message: error.message.length > 0 ? error.message : error.name,
    });
  }
  return createGitError({
    code: "GIT_UNKNOWN",
    message: "Unknown Git Remote failure",
    details: typeof error === "string" ? error : undefined,
  });
}
