import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";
import type {
  MacosAlarmHelperRequest,
  MacosAlarmHelperResponse,
} from "./types";

const HELPER_ENV_OVERRIDE = "ELIZA_MACOSALARM_HELPER_BIN";

export interface HelperSpawn {
  (bin: string, args: string[]): ChildProcessWithoutNullStreams;
}

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

  const payload = `${JSON.stringify(request)}\n`;
  proc.stdin.end(payload);

  const exitCode = await new Promise<number | null>(
    (resolvePromise, rejectPromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          rejectPromise(
            new Error(
              `macosalarm helper timed out after ${options.timeoutMs}ms`,
            ),
          );
        }, options.timeoutMs);
      }
      proc.on("error", (err: Error) => {
        if (timer) clearTimeout(timer);
        rejectPromise(err);
      });
      proc.on("close", (code: number | null) => {
        if (timer) clearTimeout(timer);
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
