/**
 * Captures synchronous child output through files for Bun test compatibility.
 *
 * Bun 1.3.14 can return empty stdout and stderr pipes from both
 * node:child_process.spawnSync and Bun.spawnSync while its test runner is
 * active. Numeric descriptors still behave correctly, so script contract
 * tests use this adapter until the runtime's pipe capture is reliable.
 */

import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function decode(buffer, encoding) {
  if (encoding === undefined || encoding === null || encoding === "buffer") {
    return buffer;
  }
  return buffer.toString(encoding);
}

function usesDefaultPipes(stdio) {
  if (stdio === undefined || stdio === "pipe") return true;
  return (
    Array.isArray(stdio) &&
    (stdio[1] === undefined || stdio[1] === "pipe") &&
    (stdio[2] === undefined || stdio[2] === "pipe")
  );
}

export function spawnSync(command, argsOrOptions, maybeOptions) {
  const hasArgs = Array.isArray(argsOrOptions);
  const args = hasArgs ? argsOrOptions : [];
  const options = (hasArgs ? maybeOptions : argsOrOptions) ?? {};
  if (!usesDefaultPipes(options.stdio)) {
    return nodeSpawnSync(command, ...(hasArgs ? [args, options] : [options]));
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
    let result;
    if (typeof globalThis.Bun !== "undefined") {
      const bunResult = globalThis.Bun.spawnSync({
        cmd: [command, ...args],
        cwd: options.cwd,
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
        signal: bunResult.signalCode ?? null,
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

export function execFileSync(command, argsOrOptions, maybeOptions) {
  const hasArgs = Array.isArray(argsOrOptions);
  const result = spawnSync(command, argsOrOptions, maybeOptions);
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
  const options = (hasArgs ? maybeOptions : argsOrOptions) ?? {};
  if (options.stdio === "ignore") return null;
  return result.stdout;
}
