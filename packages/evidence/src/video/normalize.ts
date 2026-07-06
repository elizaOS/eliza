/**
 * Video normalization to the bundle's canonical delivery format: MP4 with an
 * h264 video stream and a front-loaded `moov` atom (`+faststart`). Producers
 * emit whatever their capture stack gives them — Playwright records webm, native
 * lanes record mov — but PR evidence is posted inline in GitHub, which renders
 * MP4 inline and nothing else, so every video that lands in a bundle is coerced
 * to that one shape before ingest.
 *
 * The transform is conditional, not blind: an mp4 that already carries h264 and
 * has `moov` before `mdat` is copied through untouched (re-encoding would waste
 * time and lose a generation of quality), while anything else is remuxed or
 * transcoded. `ffprobe` decides which; `ffmpeg` performs the transform. Both
 * resolve from env, PATH, then the installed static npm packages; only when all
 * resolution paths fail does the caller receive `skipped-missing-tool`.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { EvidenceError } from "../errors.ts";
import {
  resolveFfprobeBinary,
  resolveVideoBinaries,
} from "../ffmpeg-binaries.ts";

const execFileAsync = promisify(execFile);

/** Whether both ffprobe and ffmpeg are invocable (normalization needs both). */
export async function videoToolsAvailable(): Promise<
  { available: true } | { available: false; reason: string }
> {
  const tools = await resolveVideoBinaries();
  return tools.available ? { available: true } : tools;
}

/** The container + first-video-stream facts ffprobe reports for a file. */
export interface VideoProbe {
  /** ffprobe `format_name`, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  formatName: string;
  /** Codec of the first video stream, e.g. `h264`, `vp9`; null when no video. */
  videoCodec: string | null;
  /** Whether the top-level `moov` box precedes `mdat` (progressive playback). */
  faststart: boolean;
}

/** Read the top-level MP4/ISO-BMFF box types in file order (headers only). */
function readMp4BoxOrder(filePath: string): string[] {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const order: string[] = [];
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= size) {
      const read = fs.readSync(fd, header, 0, 16, offset);
      if (read < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      // Only accept printable ASCII box types; a garbage read means this is not
      // a box-structured file and we stop rather than loop on random bytes.
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      order.push(type);
      if (boxSize === 1) {
        // 64-bit extended size lives in the 8 bytes after the type field.
        boxSize = Number(header.readBigUInt64BE(8));
      }
      if (boxSize < 8) break;
      offset += boxSize;
    }
    return order;
  } finally {
    fs.closeSync(fd);
  }
}

/** Probe a video's container, first video codec, and faststart layout. */
export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const ffprobe = await resolveFfprobeBinary();
  if (!ffprobe.available) {
    throw new EvidenceError(ffprobe.reason, { code: "FFPROBE_UNAVAILABLE" });
  }
  return probeVideoWithBin(filePath, ffprobe.bin);
}

async function probeVideoWithBin(
  filePath: string,
  ffprobeBin: string,
): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(
    ffprobeBin,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeout: 30_000 },
  );
  const parsed = JSON.parse(stdout) as {
    format?: { format_name?: string };
    streams?: { codec_type?: string; codec_name?: string }[];
  };
  const formatName = parsed.format?.format_name ?? "";
  const videoStream = (parsed.streams ?? []).find(
    (stream) => stream.codec_type === "video",
  );
  const videoCodec = videoStream?.codec_name ?? null;
  const isMp4Container = formatName
    .split(",")
    .some((name) => name === "mp4" || name === "mov");
  const order = isMp4Container ? readMp4BoxOrder(filePath) : [];
  const moov = order.indexOf("moov");
  const mdat = order.indexOf("mdat");
  const faststart = moov >= 0 && mdat >= 0 && moov < mdat;
  return { formatName, videoCodec, faststart };
}

/** Outcome of {@link normalizeVideo}: how the input reached the canonical MP4. */
export type NormalizeOutcome =
  | { status: "copied"; probe: VideoProbe }
  | { status: "remuxed"; probe: VideoProbe }
  | { status: "transcoded"; probe: VideoProbe }
  | { status: "skipped-missing-tool"; reason: string };

const CANONICAL_MP4_ARGS = [
  "-map",
  "0",
  "-map",
  "-0:s?", // drop any subtitle streams; GitHub inline playback ignores them.
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-movflags",
  "+faststart",
];

/**
 * Produce a canonical MP4 at `outPath` from `inputPath`. An mp4 that is already
 * h264 with a front-loaded `moov` is copied through byte-for-byte; an mp4 that
 * is h264 but lacks faststart is remuxed (stream copy + `+faststart`, no
 * re-encode); everything else is transcoded to h264 + faststart. Returns which
 * path was taken, or `skipped-missing-tool` when ffprobe/ffmpeg are absent.
 */
export async function normalizeVideo(
  inputPath: string,
  outPath: string,
): Promise<NormalizeOutcome> {
  const tools = await resolveVideoBinaries();
  if (!tools.available) {
    return { status: "skipped-missing-tool", reason: tools.reason };
  }
  fs.statSync(inputPath); // Throws a typed ENOENT if the source vanished.
  const probe = await probeVideoWithBin(inputPath, tools.ffprobe.bin);
  const isH264Mp4 =
    probe.videoCodec === "h264" &&
    probe.formatName
      .split(",")
      .some((name) => name === "mp4" || name === "mov");

  if (isH264Mp4 && probe.faststart) {
    if (fs.realpathSync(inputPath) !== safeRealpath(outPath)) {
      fs.copyFileSync(inputPath, outPath);
    }
    return { status: "copied", probe };
  }
  if (isH264Mp4) {
    // Already h264: remux only (stream copy) to move moov to the front.
    await execFileAsync(
      tools.ffmpeg.bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outPath,
      ],
      { timeout: 120_000 },
    );
    return { status: "remuxed", probe };
  }
  await execFileAsync(
    tools.ffmpeg.bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      ...CANONICAL_MP4_ARGS,
      outPath,
    ],
    { timeout: 600_000 },
  );
  return { status: "transcoded", probe };
}

/** realpath a path that may not exist yet (return the input for a fresh out). */
function safeRealpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // error-policy:J3 untrusted path — a not-yet-created out path has no
    // realpath; returning the literal path is correct for the equality guard.
    return filePath;
  }
}
