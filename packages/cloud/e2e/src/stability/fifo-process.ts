/**
 * Captures contained scenario output through caller-owned FIFO descriptors.
 * Runtime socketpairs never cross the sandbox boundary. Complete UTF-8 output,
 * child exit, group teardown and both EOFs must settle before success is returned.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";

interface FifoStream {
  reader: number;
  writer: number;
  keeper: number;
}

export interface FifoProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  signal?: AbortSignal;
  signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  terminateGroup: (pid: number) => Promise<void>;
}

function failure(message: string, code: string, cause?: unknown): ElizaError {
  return new ElizaError(message, { code, cause });
}

/** Owns only its new directory, descriptors and the returned child group. */
export async function runFifoProcess(options: FifoProcessOptions): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  closedAt: number;
}> {
  if (process.platform !== "linux") {
    throw failure(
      "FIFO containment requires Linux",
      "STABILITY_FIFO_UNAVAILABLE",
    );
  }
  if (options.signal?.aborted) {
    throw failure(
      "Scenario capture was cancelled",
      "STABILITY_CAPTURE_CANCELLED",
    );
  }
  const directory = mkdtempSync(path.join(tmpdir(), "eliza-scenario-stdio-"));
  const owned = new Set<number>();
  let pid: number | undefined;
  let primary: unknown;
  let exitFailure: unknown;
  const cleanupErrors: unknown[] = [];
  let stopReaders = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  let terminated = false;
  let result:
    | { stdout: string; stderr: string; code: number | null; closedAt: number }
    | undefined;
  const close = (fd: number) => {
    if (!owned.has(fd)) return;
    closeSync(fd);
    owned.delete(fd);
  };
  const fail = (error: unknown) => {
    primary ??= error;
    if (pid !== undefined) {
      try {
        options.signalGroup(pid, "SIGKILL");
      } catch (killError) {
        // error-policy:J6 Preserve the capture failure and retain teardown failure.
        cleanupErrors.push(killError);
      }
    }
  };
  try {
    const owner = lstatSync(directory);
    if (owner.uid !== process.getuid?.() || (owner.mode & 0o777) !== 0o700) {
      throw failure(
        "Capture directory is not privately owned",
        "STABILITY_FIFO_IDENTITY",
      );
    }
    const files = [
      path.join(directory, "stdout"),
      path.join(directory, "stderr"),
    ];
    const prepared = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-c",
        "import os,sys; [os.mkfifo(p,0o600) for p in sys.argv[1:]]",
        ...files,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
      },
    );
    if (prepared.error || prepared.status !== 0) {
      throw failure(
        "Owned FIFO creation failed",
        "STABILITY_FIFO_PREPARE",
        prepared.error,
      );
    }
    const streams = files.map((file): FifoStream => {
      const expected = lstatSync(file);
      if (
        !expected.isFIFO() ||
        expected.uid !== owner.uid ||
        (expected.mode & 0o777) !== 0o600
      ) {
        throw failure(
          "Capture FIFO identity is invalid",
          "STABILITY_FIFO_IDENTITY",
        );
      }
      const open = (flags: number) => {
        const fd = openSync(
          file,
          flags |
            constants.O_NOFOLLOW |
            (flags === constants.O_RDONLY ? constants.O_NONBLOCK : 0),
        );
        owned.add(fd);
        const actual = fstatSync(fd);
        if (
          !actual.isFIFO() ||
          actual.dev !== expected.dev ||
          actual.ino !== expected.ino
        ) {
          throw failure("Capture FIFO was replaced", "STABILITY_FIFO_IDENTITY");
        }
        return fd;
      };
      // Keepers prevent an open/EOF race while establishing both directional ends.
      return {
        keeper: open(constants.O_RDWR),
        reader: open(constants.O_RDONLY),
        writer: open(constants.O_WRONLY),
      };
    });
    const out = streams[0];
    const err = streams[1];
    if (!out || !err)
      throw failure("Capture streams are absent", "STABILITY_FIFO_PREPARE");
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ["ignore", out.writer, err.writer],
    });
    let closedAt = 0;
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        fail(
          failure("Scenario could not start", "STABILITY_CAPTURE_SPAWN", error),
        );
        resolve(null);
      });
      child.once("exit", (code) => {
        closedAt = Date.now();
        resolve(code);
      });
    });
    pid = child.pid;
    for (const stream of streams) {
      close(stream.writer);
      close(stream.keeper);
    }
    if (pid === undefined) {
      await exited;
      throw (
        primary ??
        failure("Scenario has no process group", "STABILITY_CAPTURE_SPAWN")
      );
    }
    const read = async (
      fd: number,
      limit: number,
      label: string,
    ): Promise<string> => {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const buffer = Buffer.alloc(64 * 1024);
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (!stopReaders) {
          let count: number;
          try {
            count = readSync(fd, buffer, 0, buffer.length, null);
          } catch (error) {
            // error-policy:J4 Nonblocking FIFO emptiness is pending, not EOF.
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "EAGAIN"
            ) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              continue;
            }
            throw error;
          }
          if (count === 0) {
            chunks.push(decoder.decode());
            return chunks.join("");
          }
          bytes += count;
          if (bytes > limit) {
            throw failure(
              `${label} exceeded its diagnostic byte limit`,
              "STABILITY_CAPTURE_SIZE",
            );
          }
          chunks.push(
            decoder.decode(buffer.subarray(0, count), { stream: true }),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw failure(
          `${label} did not reach EOF`,
          "STABILITY_CAPTURE_INCOMPLETE",
        );
      } catch (error) {
        // error-policy:J2 Capture failure kills the owned group and is never a prefix success.
        fail(
          error instanceof ElizaError
            ? error
            : failure(
                `${label} capture failed`,
                "STABILITY_CAPTURE_READ",
                error,
              ),
        );
        return "";
      }
    };
    const output = Promise.all([
      read(out.reader, options.stdoutLimitBytes, "stdout"),
      read(err.reader, options.stderrLimitBytes, "stderr"),
    ]);
    abort = () =>
      fail(
        failure(
          "Scenario capture was cancelled",
          "STABILITY_CAPTURE_CANCELLED",
        ),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    let forceSettlement = () => {};
    const forced = new Promise<null>((resolve) => {
      forceSettlement = () => resolve(null);
    });
    timer = setTimeout(() => {
      primary ??= failure(
        "Scenario capture deadline expired",
        "STABILITY_CAPTURE_TIMEOUT",
      );
      try {
        if (pid !== undefined) options.signalGroup(pid, "SIGTERM");
      } catch (error) {
        // error-policy:J6 Deadline remains primary while escalation is still attempted.
        cleanupErrors.push(error);
      }
      escalation = setTimeout(() => {
        fail(primary);
        stopReaders = true;
        forceSettlement();
      }, 5_000);
    }, options.timeoutMs);
    const code = await Promise.race([exited, forced]);
    if (code !== 0) {
      exitFailure = failure(
        `Scenario exited with code ${String(code)}`,
        "STABILITY_CAPTURE_EXIT",
      );
    }
    try {
      await options.terminateGroup(pid);
      terminated = true;
    } catch (error) {
      // error-policy:J6 Preserve primary process failure and record failed group cleanup.
      cleanupErrors.push(error);
      stopReaders = true;
    }
    const [stdout, stderr] = await output;
    if (primary !== undefined) throw primary;
    if (cleanupErrors.length) throw cleanupErrors[0];
    result = { stdout, stderr, code, closedAt };
  } catch (error) {
    // error-policy:J2 The final boundary preserves this failure through cleanup.
    primary ??= error;
  } finally {
    if (timer) clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", abort);
    stopReaders = true;
    if (pid !== undefined && !terminated) {
      try {
        await options.terminateGroup(pid);
      } catch (error) {
        // error-policy:J6 Capture error remains primary, with cleanup failure retained.
        cleanupErrors.push(error);
      }
    }
    for (const fd of owned) {
      try {
        close(fd);
      } catch (error) {
        // error-policy:J6 Finish closing every other owned descriptor before reporting.
        cleanupErrors.push(error);
      }
    }
    try {
      rmSync(directory, { recursive: true });
    } catch (error) {
      // error-policy:J6 Filesystem cleanup is part of qualification, never silently skipped.
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    throw failure(
      "Scenario capture cleanup failed",
      "STABILITY_CAPTURE_CLEANUP",
      new AggregateError(
        primary === undefined && exitFailure === undefined
          ? cleanupErrors
          : [primary ?? exitFailure, ...cleanupErrors],
      ),
    );
  }
  if (primary !== undefined) throw primary;
  if (!result)
    throw failure(
      "Scenario capture did not settle",
      "STABILITY_CAPTURE_INCOMPLETE",
    );
  return result;
}
