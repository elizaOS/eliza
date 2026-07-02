/**
 * Process seam for the birdclaw CLI.
 *
 * birdclaw's contract is "stable `--json` envelopes go to stdout, progress and
 * warnings to stderr" — so this runner treats the exit code as the only
 * success signal, parses stdout as JSON, and keeps a stderr tail purely for
 * error reporting. Everything is `execFile` with an argv array (never a shell
 * string), so user-supplied queries can't inject.
 *
 * The `BirdclawExec` seam is injectable: unit tests drive the runner with a
 * fake process, and `birdclaw.real.test.ts` swaps in the real binary.
 */

import { execFile } from "node:child_process";

/** Failure classes the service and routes branch on. */
export type BirdclawCliErrorKind =
  | "not-installed"
  | "timeout"
  | "failed"
  | "bad-json";

export class BirdclawCliError extends Error {
  readonly kind: BirdclawCliErrorKind;
  /** Last ~2KB of stderr — birdclaw writes its human diagnostics there. */
  readonly stderrTail: string;

  constructor(kind: BirdclawCliErrorKind, message: string, stderrTail = "") {
    super(message);
    this.name = "BirdclawCliError";
    this.kind = kind;
    this.stderrTail = stderrTail;
  }
}

export interface BirdclawExecResult {
  stdout: string;
  stderr: string;
}

export interface BirdclawExecOptions {
  env: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes: number;
}

/**
 * Run a binary with argv and resolve stdout/stderr. Rejections carry a typed
 * {@link BirdclawCliError}: ENOENT → `not-installed`, timeout kill →
 * `timeout`, any non-zero exit → `failed` with the stderr tail.
 */
export type BirdclawExec = (
  bin: string,
  args: readonly string[],
  options: BirdclawExecOptions,
) => Promise<BirdclawExecResult>;

const STDERR_TAIL_BYTES = 2048;

function tail(text: string): string {
  return text.length > STDERR_TAIL_BYTES
    ? text.slice(text.length - STDERR_TAIL_BYTES)
    : text;
}

type ExecFileFailure = Error & {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
};

/** Default exec: `node:child_process.execFile` (works under Bun and Node). */
export const defaultBirdclawExec: BirdclawExec = (bin, args, options) =>
  new Promise<BirdclawExecResult>((resolve, reject) => {
    execFile(
      bin,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const failure = error as ExecFileFailure;
        const stderrTail = tail(failure.stderr ?? stderr ?? "");
        if (failure.code === "ENOENT") {
          reject(
            new BirdclawCliError(
              "not-installed",
              `birdclaw binary not found at "${bin}"`,
              stderrTail,
            ),
          );
          return;
        }
        if (failure.killed || failure.signal === "SIGTERM") {
          reject(
            new BirdclawCliError(
              "timeout",
              `birdclaw ${args[0] ?? ""} timed out after ${options.timeoutMs}ms`,
              stderrTail,
            ),
          );
          return;
        }
        reject(
          new BirdclawCliError(
            "failed",
            `birdclaw ${args.join(" ")} failed${stderrTail ? `: ${stderrTail.trim()}` : ""}`,
            stderrTail,
          ),
        );
      },
    );
  });

/**
 * Run a birdclaw command and parse its stdout JSON envelope.
 *
 * With `allowTextFallback` (used for `digest`, which streams markdown before
 * its envelope stabilizes), unparseable stdout resolves to the raw text
 * instead of rejecting.
 */
export async function runBirdclawJson(
  exec: BirdclawExec,
  bin: string,
  args: readonly string[],
  options: BirdclawExecOptions,
): Promise<unknown> {
  const { stdout, stderr } = await exec(bin, args, options);
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new BirdclawCliError(
      "bad-json",
      `birdclaw ${args.join(" ")} produced no stdout`,
      tail(stderr),
    );
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new BirdclawCliError(
      "bad-json",
      `birdclaw ${args.join(" ")} stdout was not valid JSON`,
      tail(stderr),
    );
  }
}

/** Run a birdclaw command and resolve trimmed plain-text stdout. */
export async function runBirdclawText(
  exec: BirdclawExec,
  bin: string,
  args: readonly string[],
  options: BirdclawExecOptions,
): Promise<string> {
  const { stdout } = await exec(bin, args, options);
  return stdout.trim();
}
