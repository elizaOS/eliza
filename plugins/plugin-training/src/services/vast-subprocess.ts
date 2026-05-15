/**
 * Subprocess primitives for the Vast training service.
 *
 * Two helpers, both backed by `node:child_process.spawn` via an injectable
 * `spawnImpl` so tests can stand in fake children:
 *
 *   - `runCapture`    — wait for the child to exit, return stdout, throw
 *                       `VastServiceError` on non-zero exit.
 *   - `runDetachedToLog` — stream stdout + stderr into a per-job append-only
 *                       log, resolve with the exit code (no throw on non-zero;
 *                       the caller decides what a non-zero exit means).
 *
 * Both helpers normalize ENOENT-on-binary into a 503 `VastServiceError` so
 * routes can return an actionable failure when `bash`, `python`, or `uv`
 * isn't on PATH.
 */

import type { spawn } from "node:child_process";
import { appendJobLog } from "./vast-job-store.js";

export class VastServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "VastServiceError";
  }
}

export type SpawnImpl = typeof spawn;

export function runCapture(
  spawnImpl: SpawnImpl,
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  return new Promise<string>((resolveCapture, rejectCapture) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        rejectCapture(
          new VastServiceError(`Required binary not found: ${command}`, 503),
        );
        return;
      }
      rejectCapture(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveCapture(stdout);
      } else {
        rejectCapture(
          new VastServiceError(
            `${command} exited ${code}: ${stderr.slice(0, 500)}`,
            500,
          ),
        );
      }
    });
  });
}

export function runDetachedToLog(
  spawnImpl: SpawnImpl,
  jobId: string,
  command: string,
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<number> {
  return new Promise<number>((resolveProc, rejectProc) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onChunk = (chunk: Buffer) => {
      void appendJobLog(jobId, chunk.toString("utf8")).catch(() => {});
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        rejectProc(
          new VastServiceError(`Required binary not found: ${command}`, 503),
        );
        return;
      }
      rejectProc(err);
    });
    child.on("close", (code) => resolveProc(code ?? -1));
  });
}
