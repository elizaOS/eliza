/**
 * Captures synchronous child output through files for Bun test compatibility.
 *
 * Bun 1.4.2 can return empty stdout and stderr pipes from both
 * node:child_process.spawnSync and Bun.spawnSync while its test runner is
 * active. Numeric descriptors still behave correctly, so script contract
 * tests use this adapter until the runtime's pipe capture is reliable.
 */

import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isSignal(value: string): value is NodeJS.Signals {
  return Object.hasOwn(osConstants.signals, value);
}

function normalizeSignal(
  value: string | null | undefined,
): NodeJS.Signals | null {
  if (value == null) return null;
  if (isSignal(value)) return value;
  throw new Error(`Unknown subprocess signal: ${value}`);
}

function decode(buffer: Buffer, encoding: SpawnSyncOptions["encoding"]) {
  if (encoding === undefined || encoding === null || encoding === "buffer") {
    return buffer;
  }
  return buffer.toString(encoding);
}

function usesDefaultPipes(stdio: SpawnSyncOptions["stdio"]) {
  if (stdio === undefined || stdio === "pipe") return true;
  return (
    Array.isArray(stdio) &&
    (stdio[1] === undefined || stdio[1] === "pipe") &&
    (stdio[2] === undefined || stdio[2] === "pipe")
  );
}

function isArgs(
  value: readonly string[] | SpawnSyncOptions | undefined,
): value is readonly string[] {
  return Array.isArray(value);
}

export function spawnSync(
  command: string,
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSync(
  command: string,
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function spawnSync(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function spawnSync(
  command: string,
  argsOrOptions?: readonly string[] | SpawnSyncOptions,
  maybeOptions?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer> {
  const args = isArgs(argsOrOptions) ? argsOrOptions : [];
  const options = (isArgs(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
  if (!usesDefaultPipes(options.stdio)) {
    return nodeSpawnSync(command, args, options);
  }

  const directory = mkdtempSync(
    path.join(tmpdir(), "eliza-spawn-sync-captured-"),
  );
  const stdinPath = path.join(directory, "stdin");
  const stdoutPath = path.join(directory, "stdout");
  const stderrPath = path.join(directory, "stderr");
  let stdin = -1;
  let stdout = -1;
  let stderr = -1;

  try {
    if (options.input !== undefined) {
      writeFileSync(stdinPath, options.input, {
        encoding:
          options.encoding && options.encoding !== "buffer"
            ? options.encoding
            : undefined,
      });
      stdin = openSync(stdinPath, "r");
    }
    let result: Pick<
      SpawnSyncReturns<string | Buffer>,
      "error" | "pid" | "signal" | "status"
    >;
    if (typeof globalThis.Bun !== "undefined") {
      const bunResult = globalThis.Bun.spawnSync({
        cmd: [command, ...args],
        cwd:
          typeof options.cwd === "string" || options.cwd === undefined
            ? options.cwd
            : fileURLToPath(options.cwd),
        env: options.env,
        stderr: globalThis.Bun.file(stderrPath),
        stdin: stdin >= 0 ? globalThis.Bun.file(stdinPath) : "ignore",
        stdout: globalThis.Bun.file(stdoutPath),
        timeout: options.timeout,
      });
      result = {
        error: bunResult.exitedDueToTimeout
          ? new Error(`spawnSync ${command} ETIMEDOUT`)
          : undefined,
        pid: bunResult.pid,
        signal: normalizeSignal(bunResult.signalCode),
        status: bunResult.exitCode,
      };
    } else {
      stdout = openSync(stdoutPath, "w");
      stderr = openSync(stderrPath, "w");
      result = nodeSpawnSync(command, args, {
        ...options,
        input: undefined,
        stdio: [stdin >= 0 ? stdin : "ignore", stdout, stderr],
      });
      closeSync(stdout);
      stdout = -1;
      closeSync(stderr);
      stderr = -1;
    }
    const capturedStdout = decode(readFileSync(stdoutPath), options.encoding);
    const capturedStderr = decode(readFileSync(stderrPath), options.encoding);
    return {
      ...result,
      output: [null, capturedStdout, capturedStderr],
      stderr: capturedStderr,
      stdout: capturedStdout,
    };
  } finally {
    if (stdin >= 0) closeSync(stdin);
    if (stdout >= 0) closeSync(stdout);
    if (stderr >= 0) closeSync(stderr);
    rmSync(directory, { recursive: true, force: true });
  }
}

export function execFileSync(
  command: string,
  options: SpawnSyncOptions & { stdio: "ignore" },
): null;
export function execFileSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions & { stdio: "ignore" },
): null;
export function execFileSync(
  command: string,
  options: SpawnSyncOptionsWithStringEncoding,
): string;
export function execFileSync(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): string;
export function execFileSync(
  command: string,
  options?: SpawnSyncOptions,
): string | Buffer | null;
export function execFileSync(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): string | Buffer | null;
export function execFileSync(
  command: string,
  argsOrOptions?: readonly string[] | SpawnSyncOptions,
  maybeOptions?: SpawnSyncOptions,
): string | Buffer | null {
  const options = (isArgs(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
  const args = isArgs(argsOrOptions) ? argsOrOptions : [];
  const result = spawnSync(command, args, options);
  if (result.error || result.status !== 0) {
    const error =
      result.error ?? new Error(`${command} exited ${result.status}`);
    Object.assign(error, {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    });
    throw error;
  }
  if (options.stdio === "ignore") return null;
  return result.stdout;
}
