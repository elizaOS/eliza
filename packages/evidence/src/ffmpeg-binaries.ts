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

/** Whether a binary answers `-version`, with a reason when it does not. */
async function binaryAvailable(
  bin: string,
): Promise<{ available: true } | { available: false; reason: string }> {
  try {
    await execFileAsync(bin, ["-version"], { timeout: 10_000 });
    return { available: true };
  } catch (error) {
    const enoent = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return {
      available: false,
      reason: enoent
        ? `${bin} not installed`
        : `${bin} -version failed: ${String(
            error instanceof Error ? error.message : error,
          ).slice(0, 160)}`,
    };
  }
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

function installFfmpegStaticOnce(): Promise<
  { installed: true } | { installed: false; reason: string }
> {
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
      await execFileAsync(process.execPath, [installer], {
        cwd: root,
        timeout: 120_000,
      });
      return { installed: true };
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

  const installed = await installFfmpegStaticOnce();
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
