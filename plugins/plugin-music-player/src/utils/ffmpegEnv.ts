import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname } from "node:path";

const require = createRequire(import.meta.url);

function tryFfmpegStaticPath(): string | null {
  try {
    const p = require("ffmpeg-static") as unknown;
    if (typeof p === "string" && p.length > 0 && existsSync(p)) return p;
  } catch {
    /* optional */
  }
  return null;
}

function tryFfprobeStaticPath(): string | null {
  try {
    const mod = require("ffprobe-static") as { path?: string } | string;
    const p = typeof mod === "string" ? mod : mod?.path;
    if (typeof p === "string" && p.length > 0 && existsSync(p)) return p;
  } catch {
    /* optional */
  }
  return null;
}

/** Prefer FFMPEG_PATH, then ffmpeg-static, then plain `ffmpeg` on PATH. */
export function resolveFfmpegBinaryPath(): string {
  const env = process.env.FFMPEG_PATH?.trim();
  if (env && existsSync(env)) {
    return env;
  }
  const staticFfmpeg = tryFfmpegStaticPath();
  if (staticFfmpeg) {
    return staticFfmpeg;
  }
  return "ffmpeg";
}

/** Prefer FFPROBE_PATH, then ffprobe-static, then plain `ffprobe` on PATH. */
export function resolveFfprobeBinaryPath(): string {
  const env = process.env.FFPROBE_PATH?.trim();
  if (env && existsSync(env)) {
    return env;
  }
  return tryFfprobeStaticPath() ?? "ffprobe";
}

/**
 * Directories to prepend to PATH so yt-dlp finds `ffmpeg` and `ffprobe`.
 *
 * Resolution order:
 * - `FFMPEG_LOCATION` — directory containing both binaries (yt-dlp `--ffmpeg-location` style)
 * - `FFMPEG_PATH` / `FFPROBE_PATH` — explicit binary paths; their parent dirs are added
 * - `ffmpeg-static` / `ffprobe-static` npm packages (prebuilt binaries per platform)
 */
export function getFfmpegToolSearchDirs(): string[] {
  const dirs = new Set<string>();

  const loc = process.env.FFMPEG_LOCATION?.trim();
  if (loc && existsSync(loc)) {
    dirs.add(loc);
  }

  const ffmpegEnv = process.env.FFMPEG_PATH?.trim();
  if (ffmpegEnv && existsSync(ffmpegEnv)) {
    dirs.add(dirname(ffmpegEnv));
  }

  const ffprobeEnv = process.env.FFPROBE_PATH?.trim();
  if (ffprobeEnv && existsSync(ffprobeEnv)) {
    dirs.add(dirname(ffprobeEnv));
  }

  const staticFfmpeg = tryFfmpegStaticPath();
  if (staticFfmpeg) {
    dirs.add(dirname(staticFfmpeg));
  }

  const staticFfprobe = tryFfprobeStaticPath();
  if (staticFfprobe) {
    dirs.add(dirname(staticFfprobe));
  }

  return [...dirs];
}

/** Merge ffmpeg/ffprobe dirs into PATH (and `Path` on Windows). */
export function augmentEnvWithFfmpegTools(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const toolDirs = getFfmpegToolSearchDirs();
  if (toolDirs.length === 0) {
    return { ...base };
  }

  const prefix = toolDirs.join(delimiter);
  const currentPath = base.PATH ?? base.Path ?? "";
  const merged = currentPath ? `${prefix}${delimiter}${currentPath}` : prefix;

  const out: NodeJS.ProcessEnv = { ...base, PATH: merged };
  if (process.platform === "win32") {
    out.Path = merged;
  }
  return out;
}
