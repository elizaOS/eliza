/**
 * Validates transcoded browser-video evidence before it is labeled video/mp4
 * (#29774). A transcoder exit code of zero is not proof of a usable file: a
 * zero-byte, malformed, wrong-codec, zero-duration, multi-stream, or swapped
 * output must never be published as MP4 evidence.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type BrowserVideoEvidenceRejection =
  | "missing"
  | "not_regular_file"
  | "empty"
  | "probe_failed"
  | "probe_invalid_json"
  | "not_mp4_container"
  | "invalid_duration"
  | "unexpected_stream_count"
  | "not_video_stream"
  | "wrong_codec"
  | "wrong_pixel_format"
  | "wrong_dimensions"
  | "mutated_during_validation";

export class BrowserVideoEvidenceError extends Error {
  readonly code = "BROWSER_VIDEO_EVIDENCE_INVALID";
  readonly reason: BrowserVideoEvidenceRejection;

  constructor(reason: BrowserVideoEvidenceRejection) {
    super(`Browser video evidence is not a valid MP4 (${reason})`);
    this.name = "BrowserVideoEvidenceError";
    this.reason = reason;
  }
}

export interface BrowserVideoEvidenceProbe {
  container: "mp4";
  codec: "h264";
  pixelFormat: "yuv420p";
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  sha256: string;
}

function executable(command: string | undefined): command is string {
  if (!command) return false;
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function packagedFfprobe(): string | undefined {
  try {
    const loaded = require("ffprobe-static") as { path?: string } | string;
    return typeof loaded === "string" ? loaded : loaded?.path;
  } catch {
    // error-policy:J1 dependency boundary; the caller receives undefined and
    // reports an unvalidated transcode instead of labeling it MP4.
    return undefined;
  }
}

/** Resolves an executable ffprobe: explicit override, PATH, then the bundled binary. */
export function resolveFfprobe(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return [env.FFPROBE_PATH, "ffprobe", packagedFfprobe()].find(executable);
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function reject(reason: BrowserVideoEvidenceRejection): never {
  throw new BrowserVideoEvidenceError(reason);
}

/**
 * Probes one completed MP4 and returns its closed metadata, or throws a typed
 * rejection. The file must be a regular non-symlink file whose bytes do not
 * change while it is probed.
 */
export function validateBrowserVideoMp4(
  file: string,
  options: {
    ffprobe: string;
    expectedWidth?: number;
    expectedHeight?: number;
  },
): BrowserVideoEvidenceProbe {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    // error-policy:J3 a missing output is a typed rejection, not a skip.
    return reject("missing");
  }
  if (!stat.isFile()) reject("not_regular_file");
  if (stat.size === 0) reject("empty");
  const digestBefore = sha256File(file);

  const probe = spawnSync(
    options.ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (probe.error || probe.status !== 0) reject("probe_failed");

  let parsed: {
    format?: { format_name?: unknown; duration?: unknown };
    streams?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(probe.stdout);
  } catch {
    // error-policy:J3 ffprobe output is external input and must parse exactly.
    return reject("probe_invalid_json");
  }
  const formatNames =
    typeof parsed.format?.format_name === "string"
      ? parsed.format.format_name.split(",")
      : [];
  if (!formatNames.includes("mp4")) reject("not_mp4_container");
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) reject("invalid_duration");
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  if (streams.length !== 1) reject("unexpected_stream_count");
  const [stream] = streams;
  if (stream.codec_type !== "video") reject("not_video_stream");
  if (stream.codec_name !== "h264") reject("wrong_codec");
  if (stream.pix_fmt !== "yuv420p") reject("wrong_pixel_format");
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    (options.expectedWidth !== undefined && width !== options.expectedWidth) ||
    (options.expectedHeight !== undefined && height !== options.expectedHeight)
  ) {
    reject("wrong_dimensions");
  }

  const after = fs.lstatSync(file);
  if (
    !after.isFile() ||
    after.size !== stat.size ||
    sha256File(file) !== digestBefore
  ) {
    reject("mutated_during_validation");
  }
  return {
    container: "mp4",
    codec: "h264",
    pixelFormat: "yuv420p",
    width,
    height,
    durationSeconds: duration,
    sizeBytes: stat.size,
    sha256: digestBefore,
  };
}
