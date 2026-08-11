/**
 * FFmpeg and ffprobe binary resolution for evidence video analysis. Evidence
 * producers should work on a clean checkout without hand-installed media tools,
 * so system binaries are preferred when present and the npm-packaged static
 * binaries provide the install-time fallback. Explicit env paths stay strict so
 * CI lanes can pin a known binary and fail loudly when that pin is broken.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delayMs } from "node:timers/promises";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

type ToolName = "ffmpeg" | "ffprobe";

interface ToolResolution {
  bin: string;
  source: "env" | "system" | "bundled";
}

interface BundledPathResult {
  bin: string | null;
  reason?: string;
}

let ffmpegStaticInstallPromise: Promise<
  { installed: true } | { installed: false; reason: string }
> | null = null;

function isNodeExecutable(candidate: string): boolean {
  return /^(node|nodejs)(\.exe)?$/i.test(candidate);
}

export function resolveNodeInstallRunner({
  env = process.env,
  execPath = process.execPath,
}: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
} = {}): string {
  const configured = env.ELIZA_NODE_BIN?.trim() || env.NODE_BINARY?.trim();
  if (configured) return configured;

  const posixName = path.basename(execPath);
  const winName = path.win32.basename(execPath);
  return isNodeExecutable(posixName) || isNodeExecutable(winName)
    ? execPath
    : "node";
}

// Exec failures that clear on their own once a concurrent writer closes the
// binary it is still producing: ETXTBSY means "open for write while exec'd",
// which happens when a sibling process races the same lazy binary install.
const TRANSIENT_PROBE_CODES = new Set(["ETXTBSY", "EBUSY", "EAGAIN"]);
const PROBE_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600];

type ProbeExec = (
  bin: string,
  args: string[],
  options: { timeout: number },
) => Promise<unknown>;

/**
 * Whether a binary answers `-version`, with a reason when it does not.
 * Transient exec codes are retried on a short backoff so a cross-process
 * install race degrades into a slightly slower probe instead of a false
 * "bundled binary failed". `execProbe` is injectable for deterministic tests.
 */
export async function probeBinaryAvailable(
  bin: string,
  execProbe: ProbeExec = (probeBin, args, options) =>
    execFileAsync(probeBin, args, options),
): Promise<{ available: true } | { available: false; reason: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await execProbe(bin, ["-version"], { timeout: 10_000 });
      return { available: true };
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        return { available: false, reason: `${bin} not installed` };
      }
      if (
        typeof code === "string" &&
        TRANSIENT_PROBE_CODES.has(code) &&
        attempt < PROBE_RETRY_DELAYS_MS.length
      ) {
        await delayMs(PROBE_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      break;
    }
  }
  return {
    available: false,
    reason: `${bin} -version failed: ${String(
      lastError instanceof Error ? lastError.message : lastError,
    ).slice(0, 160)}`,
  };
}

async function binaryAvailable(
  bin: string,
): Promise<{ available: true } | { available: false; reason: string }> {
  return probeBinaryAvailable(bin);
}

function envPath(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requireFfmpegStaticPath(): string | null {
  try {
    const mod = require("ffmpeg-static") as unknown;
    return typeof mod === "string" && mod.length > 0 ? mod : null;
  } catch (error) {
    // error-policy:J3 optional packaged binary — absence is reported by caller.
    void error;
  }
  return null;
}

function packageRoot(packageName: string): string | null {
  try {
    return path.dirname(require.resolve(packageName));
  } catch (error) {
    // error-policy:J3 optional packaged binary — absence is reported by caller.
    void error;
  }
  return null;
}

const INSTALL_LOCK_STALE_MS = 180_000;
const INSTALL_LOCK_POLL_MS = 250;

/**
 * Serialize a critical section across processes through an atomic lock
 * directory. The per-process install memo below cannot see sibling test
 * workers, so without this every worker races the same download into the same
 * package directory and one of them execs a binary another still has open for
 * write (spawn ETXTBSY). A lock left behind by a crashed holder is reclaimed
 * after `staleMs` so one dead process cannot poison every later install.
 */
export async function withInstallLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  {
    staleMs = INSTALL_LOCK_STALE_MS,
    pollMs = INSTALL_LOCK_POLL_MS,
  }: { staleMs?: number; pollMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + staleMs * 2;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > staleMs) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        // error-policy:J6 the holder released between the stat and the rmdir;
        // loop back to the acquire attempt.
      }
      if (Date.now() > deadline) {
        throw new Error(
          `install lock at ${lockDir} was not released in time; remove it if no installer is running`,
        );
      }
      await delayMs(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // error-policy:J6 best-effort lock release; the stale-lock reclaim above
      // covers a release that failed here.
    }
  }
}

function installFfmpegStaticOnce(
  candidate: string,
): Promise<{ installed: true } | { installed: false; reason: string }> {
  ffmpegStaticInstallPromise ??= (async () => {
    const root = packageRoot("ffmpeg-static");
    if (root === null) {
      return {
        installed: false,
        reason: "ffmpeg-static package is not installed",
      };
    }

    const installer = path.join(root, "install.js");
    if (!fs.existsSync(installer)) {
      return {
        installed: false,
        reason: "ffmpeg-static install script is missing",
      };
    }

    try {
      return await withInstallLock(
        path.join(root, ".eliza-ffmpeg-install-lock"),
        async () => {
          // A sibling process may have completed the install while this one
          // waited on the lock; downloading again would reopen the binary for
          // write under a concurrent prober.
          if (fs.existsSync(candidate)) return { installed: true as const };
          const nodeRunner = resolveNodeInstallRunner();
          await execFileAsync(nodeRunner, [installer], {
            cwd: root,
            timeout: 120_000,
          });
          return { installed: true as const };
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        installed: false,
        reason: `ffmpeg-static install failed: ${message.slice(0, 160)}`,
      };
    }
  })();

  return ffmpegStaticInstallPromise;
}

async function bundledFfmpegPath(): Promise<BundledPathResult> {
  const candidate = requireFfmpegStaticPath();
  if (candidate === null) return { bin: null };
  if (fs.existsSync(candidate)) return { bin: candidate };

  const installed = await installFfmpegStaticOnce(candidate);
  if (!installed.installed) {
    return { bin: null, reason: installed.reason };
  }

  return fs.existsSync(candidate)
    ? { bin: candidate }
    : {
        bin: null,
        reason: `ffmpeg-static install completed but ${candidate} is still missing`,
      };
}

function bundledFfprobePath(): BundledPathResult {
  try {
    const mod = require("ffprobe-static") as { path?: string } | string;
    const candidate = typeof mod === "string" ? mod : mod.path;
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      fs.existsSync(candidate)
    ) {
      return { bin: candidate };
    }
  } catch (error) {
    // error-policy:J3 optional packaged binary — absence is reported by caller.
    void error;
  }
  return { bin: null };
}

function configuredEnvPath(tool: ToolName): string | undefined {
  return tool === "ffmpeg"
    ? envPath(["ELIZA_FFMPEG_BIN", "ELIZA_FFMPEG_PATH", "FFMPEG_PATH"])
    : envPath(["ELIZA_FFPROBE_BIN", "ELIZA_FFPROBE_PATH", "FFPROBE_PATH"]);
}

async function bundledPath(tool: ToolName): Promise<BundledPathResult> {
  return tool === "ffmpeg" ? bundledFfmpegPath() : bundledFfprobePath();
}

async function resolveTool(
  tool: ToolName,
): Promise<
  | { available: true; resolution: ToolResolution }
  | { available: false; reason: string }
> {
  const explicit = configuredEnvPath(tool);
  if (explicit !== undefined) {
    const available = await binaryAvailable(explicit);
    if (available.available) {
      return {
        available: true,
        resolution: { bin: explicit, source: "env" },
      };
    }
    return {
      available: false,
      reason: `${tool} env override is not invocable: ${available.reason}`,
    };
  }

  const system = await binaryAvailable(tool);
  if (system.available) {
    return {
      available: true,
      resolution: { bin: tool, source: "system" },
    };
  }

  const bundled = await bundledPath(tool);
  if (bundled.bin !== null) {
    const available = await binaryAvailable(bundled.bin);
    if (available.available) {
      return {
        available: true,
        resolution: { bin: bundled.bin, source: "bundled" },
      };
    }
    return {
      available: false,
      reason: `${tool} system binary missing and bundled binary failed: ${available.reason}`,
    };
  }

  return {
    available: false,
    reason: bundled.reason
      ? `${tool} not found on PATH and bundled ${tool}-static package is unavailable: ${bundled.reason}`
      : `${tool} not found on PATH and bundled ${tool}-static package is unavailable`,
  };
}

/** Resolve ffmpeg from env, PATH, or the installed `ffmpeg-static` package. */
export async function resolveFfmpegBinary(): Promise<
  | { available: true; bin: string; source: ToolResolution["source"] }
  | { available: false; reason: string }
> {
  const resolved = await resolveTool("ffmpeg");
  if (!resolved.available) return resolved;
  return { available: true, ...resolved.resolution };
}

/** Resolve ffprobe from env, PATH, or the installed `ffprobe-static` package. */
export async function resolveFfprobeBinary(): Promise<
  | { available: true; bin: string; source: ToolResolution["source"] }
  | { available: false; reason: string }
> {
  const resolved = await resolveTool("ffprobe");
  if (!resolved.available) return resolved;
  return { available: true, ...resolved.resolution };
}

/** Whether both ffprobe and ffmpeg are invocable after packaged fallback. */
export async function resolveVideoBinaries(): Promise<
  | {
      available: true;
      ffmpeg: ToolResolution;
      ffprobe: ToolResolution;
    }
  | { available: false; reason: string }
> {
  const ffprobe = await resolveFfprobeBinary();
  if (!ffprobe.available) return ffprobe;
  const ffmpeg = await resolveFfmpegBinary();
  if (!ffmpeg.available) return ffmpeg;
  return {
    available: true,
    ffmpeg: { bin: ffmpeg.bin, source: ffmpeg.source },
    ffprobe: { bin: ffprobe.bin, source: ffprobe.source },
  };
}
