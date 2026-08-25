import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type {
  MacosAlarmHelperRequest,
  MacosAlarmHelperResponse,
} from "./types";

const HELPER_ENV_OVERRIDE = "ELIZA_MACOSALARM_HELPER_BIN";

export type HelperSpawn = (
  bin: string,
  args: string[],
) => ChildProcessWithoutNullStreams;

export interface HelperRunOptions {
  spawnImpl?: HelperSpawn;
  binPathOverride?: string;
  timeoutMs?: number;
}

const defaultSpawnHelper: HelperSpawn = (bin, args) => spawn(bin, args);

function resolveHelperBin(override?: string): string {
  if (override && override.length > 0) return override;
  const envOverride = process.env[HELPER_ENV_OVERRIDE];
  if (envOverride && envOverride.length > 0) return envOverride;

  const here = dirname(fileURLToPath(import.meta.url));
  // Built binary lives at <package>/bin/macosalarm-helper; this file compiles
  // to <package>/dist/helper.js, so one-level-up gets us to the package root.
  const pkgRoot = resolve(here, "..");
  return resolve(pkgRoot, "bin", "macosalarm-helper");
}

export class MacosAlarmHelperUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`macosalarm helper unavailable: ${reason}`);
    this.name = "MacosAlarmHelperUnavailableError";
    this.reason = reason;
  }
}

export async function runHelper(
  request: MacosAlarmHelperRequest,
  options: HelperRunOptions = {},
): Promise<MacosAlarmHelperResponse> {
  if (process.platform !== "darwin" && !options.spawnImpl) {
    logger.warn(
      `[MacosAlarmHelper] refusing to run helper on non-darwin platform=${process.platform}`,
    );
    throw new MacosAlarmHelperUnavailableError("macos-only");
  }

  const bin = resolveHelperBin(options.binPathOverride);
  if (!options.spawnImpl && !existsSync(bin)) {
    logger.warn(
      `[MacosAlarmHelper] helper binary missing at ${bin}; run the package build-helper script`,
    );
    throw new MacosAlarmHelperUnavailableError("helper-binary-missing");
  }

  const spawnImpl = options.spawnImpl ?? defaultSpawnHelper;
  const proc = spawnImpl(bin, []);

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // A helper that crashes, exits early, or never reads stdin closes its read
  // end before we finish writing the request, and Node emits an `error` event
  // (EPIPE) on `proc.stdin`. That stream `error` is a distinct channel from the
  // `proc.on("error")` spawn-failure channel below; without a listener it
  // escalates to an uncaughtException and takes down the whole agent process.
  // Because this plugin is auto-enabled on darwin and ALARM is a reachable
  // action, an early-exiting helper must degrade to a structured failure, not a
  // fatal crash.
  proc.stdin.on("error", (err: Error) => {
    // error-policy:J5 the same failure is observed by the close/no-stdout path
    // below: if the helper still emitted a valid JSON response it is parsed and
    // returned, otherwise the "produced no stdout" throw fires and the action
    // boundary translates it into a structured ActionResult. The stdin pipe
    // closing is therefore not independently fatal.
    logger.debug(`[MacosAlarmHelper] stdin write error: ${err.message}`);
  });

  const payload = `${JSON.stringify(request)}\n`;
  proc.stdin.end(payload);

  const exitCode = await new Promise<number | null>(
    (resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killEscalation: ReturnType<typeof setTimeout> | undefined;
      const clearTimers = () => {
        if (timer) clearTimeout(timer);
        if (killEscalation) clearTimeout(killEscalation);
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          // Abort the hung helper before rejecting so the child process and its
          // stdin/stdout/stderr pipes are reclaimed instead of being orphaned.
          // SIGTERM lets the helper exit cleanly; escalate to SIGKILL if it
          // ignores the request. `proc.on("close")` still fires and clears the
          // escalation timer, so this never keeps the event loop alive.
          proc.kill("SIGTERM");
          killEscalation = setTimeout(() => proc.kill("SIGKILL"), 2000);
          killEscalation.unref?.();
          rejectPromise(
            new Error(
              `macosalarm helper timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }
      proc.on("error", (err: Error) => {
        clearTimers();
        rejectPromise(err);
      });
      proc.on("close", (code: number | null) => {
        clearTimers();
        resolvePromise(code);
      });
    },
  );

  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

  if (stderr.length > 0) {
    logger.debug(`[MacosAlarmHelper] stderr: ${stderr}`);
  }

  if (stdout.length === 0) {
    throw new Error(
      `macosalarm helper produced no stdout (exit=${exitCode}); stderr=${stderr}`,
    );
  }

  const lastLine = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    throw new Error(
      `macosalarm helper produced empty response (exit=${exitCode})`,
    );
  }

  const parsed = JSON.parse(lastLine) as MacosAlarmHelperResponse;
  return parsed;
}
