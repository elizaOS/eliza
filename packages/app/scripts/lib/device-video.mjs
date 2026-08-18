/**
 * Renderability validation shared by Android and iOS evidence bundles. A
 * filename, non-empty file, or plausible MP4 box list is not proof that GitHub
 * can render the artifact, so media must also decode through the repository's
 * available ffmpeg binary before it is published inline.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const verifiedCommands = new Set();
const MEDIA_PROBE_TIMEOUT_MS = 30_000;
export const MIN_EVIDENCE_VIDEO_DURATION_SECONDS = 2;
export const MIN_EVIDENCE_VIDEO_FRAMES = 2;

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function commandWorks(command, spawnSyncDep) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (spawnSyncDep === spawnSync && verifiedCommands.has(command)) return true;
  const works =
    spawnSyncDep(command, ["-version"], {
      stdio: "ignore",
      timeout: MEDIA_PROBE_TIMEOUT_MS,
    }).status === 0;
  if (works && spawnSyncDep === spawnSync) verifiedCommands.add(command);
  return works;
}

export function resolveMediaProbeBinary({
  env = process.env,
  require: requireDep = require,
  spawnSync: spawnSyncDep = spawnSync,
} = {}) {
  const explicit =
    env.ELIZA_FFMPEG_BIN?.trim() ||
    env.ELIZA_FFMPEG_PATH?.trim() ||
    env.FFMPEG_PATH?.trim();
  if (explicit) return commandWorks(explicit, spawnSyncDep) ? explicit : null;

  const candidates = ["ffmpeg"];
  try {
    const bundled = requireDep("ffmpeg-static");
    candidates.push(
      typeof bundled === "string" ? bundled : (bundled?.default ?? null),
    );
  } catch {
    // error-policy:J3 An absent optional probe is an explicit invalid result.
  }
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (commandWorks(candidate, spawnSyncDep)) return candidate;
  }
  return null;
}

export function resolveMediaMetadataProbeBinary({
  env = process.env,
  require: requireDep = require,
  spawnSync: spawnSyncDep = spawnSync,
} = {}) {
  const explicit =
    env.ELIZA_FFPROBE_BIN?.trim() || env.ELIZA_FFPROBE_PATH?.trim();
  if (explicit) return commandWorks(explicit, spawnSyncDep) ? explicit : null;

  const candidates = ["ffprobe"];
  try {
    const bundled = requireDep("ffprobe-static");
    candidates.push(
      typeof bundled === "string"
        ? bundled
        : (bundled?.path ?? bundled?.default?.path ?? null),
    );
  } catch {
    // error-policy:J3 An absent optional metadata probe is an invalid result.
  }
  for (const candidate of new Set(candidates.filter(Boolean))) {
    if (commandWorks(candidate, spawnSyncDep)) return candidate;
  }
  return null;
}

function hasRenderableH264Stream(
  filePath,
  { metadataProbeBinary, require: requireDep, spawnSync: spawnSyncDep },
) {
  const ffprobe =
    metadataProbeBinary ??
    resolveMediaMetadataProbeBinary({
      require: requireDep,
      spawnSync: spawnSyncDep,
    });
  if (!ffprobe) return false;
  const result = spawnSyncDep(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,duration,nb_frames,nb_read_frames:format=duration",
      "-count_frames",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", timeout: MEDIA_PROBE_TIMEOUT_MS },
  );
  if (result.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed?.streams?.[0];
    const duration = [stream?.duration, parsed?.format?.duration]
      .map(Number)
      .find(
        (value) =>
          Number.isFinite(value) &&
          value >= MIN_EVIDENCE_VIDEO_DURATION_SECONDS,
      );
    const frameCount = [stream?.nb_read_frames, stream?.nb_frames]
      .map(Number)
      .find(
        (value) => Number.isFinite(value) && value >= MIN_EVIDENCE_VIDEO_FRAMES,
      );
    return (
      stream?.codec_name === "h264" &&
      Number(stream?.width) > 0 &&
      Number(stream?.height) > 0 &&
      duration !== undefined &&
      frameCount !== undefined
    );
  } catch {
    return false;
  }
}

function decodesVideoFrame(
  filePath,
  { probeBinary, require: requireDep, spawnSync: spawnSyncDep },
) {
  const ffmpeg =
    probeBinary ??
    resolveMediaProbeBinary({ require: requireDep, spawnSync: spawnSyncDep });
  if (!ffmpeg) return false;
  const result = spawnSyncDep(
    ffmpeg,
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { stdio: "ignore", timeout: MEDIA_PROBE_TIMEOUT_MS },
  );
  return result.status === 0;
}

export function isRenderableVideo(
  filePath,
  {
    metadataProbeBinary,
    probeBinary,
    require: requireDep = require,
    spawnSync: spawnSyncDep = spawnSync,
  } = {},
) {
  return (
    isNonEmptyFile(filePath) &&
    hasRenderableH264Stream(filePath, {
      metadataProbeBinary,
      require: requireDep,
      spawnSync: spawnSyncDep,
    }) &&
    decodesVideoFrame(filePath, {
      probeBinary,
      require: requireDep,
      spawnSync: spawnSyncDep,
    })
  );
}

export function isRenderableJpeg(
  filePath,
  {
    probeBinary,
    require: requireDep = require,
    spawnSync: spawnSyncDep = spawnSync,
  } = {},
) {
  if (!isNonEmptyFile(filePath)) return false;
  const fd = fs.openSync(filePath, "r");
  try {
    const signature = Buffer.alloc(3);
    if (fs.readSync(fd, signature, 0, signature.length, 0) !== 3) return false;
    if (
      signature[0] !== 0xff ||
      signature[1] !== 0xd8 ||
      signature[2] !== 0xff
    ) {
      return false;
    }
  } finally {
    fs.closeSync(fd);
  }
  return decodesVideoFrame(filePath, {
    probeBinary,
    require: requireDep,
    spawnSync: spawnSyncDep,
  });
}

export function isFinalizedMp4(
  filePath,
  {
    metadataProbeBinary,
    probeBinary,
    require: requireDep = require,
    spawnSync: spawnSyncDep = spawnSync,
  } = {},
) {
  if (!isNonEmptyFile(filePath)) return false;

  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let sawFileType = false;
    let sawMovie = false;
    let sawMediaData = false;

    while (offset + 8 <= fileSize) {
      const bytesRead = fs.readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) return false;

      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let boxSize = size32;
      let headerSize = 8;
      if (size32 === 1) {
        if (bytesRead < 16) return false;
        const size64 = header.readBigUInt64BE(8);
        if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        boxSize = Number(size64);
        headerSize = 16;
      } else if (size32 === 0) {
        boxSize = fileSize - offset;
      }

      if (boxSize < headerSize || offset + boxSize > fileSize) return false;
      if (type === "ftyp") sawFileType = true;
      if (type === "moov") sawMovie = true;
      if (type === "mdat" && boxSize > headerSize) sawMediaData = true;
      offset += boxSize;
    }

    if (!(sawFileType && sawMovie && sawMediaData && offset === fileSize)) {
      return false;
    }
  } finally {
    fs.closeSync(fd);
  }
  return isRenderableVideo(filePath, {
    metadataProbeBinary,
    probeBinary,
    require: requireDep,
    spawnSync: spawnSyncDep,
  });
}
