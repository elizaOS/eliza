/**
 * Finalizes live voice captures into revision-bound evidence. The web lane
 * privately validates its real acoustic captures, then publish only black
 * video and non-intelligible, duration-only tone projections. Source waveforms,
 * speech, transcripts, and correlation inputs never enter public artifacts.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const ACOUSTIC_PROJECTION = Object.freeze({
  schema: "eliza_voice_duration_only_acoustic_projection_v1",
  privacyClass: "non-intelligible-non-reconstructible",
  sourceFeature: "duration-only",
  signal: "fixed-frequency-sine",
  frequencyHz: 997,
  sampleRateHz: 48_000,
  channels: 1,
  peakAmplitude: 0.03125,
});

function executable(command) {
  if (!command) return false;
  const result = spawnSync(command, ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function packagedBinary(name) {
  try {
    const loaded = require(name);
    return typeof loaded === "string" ? loaded : loaded?.path;
  } catch {
    // error-policy:J1 dependency boundary — resolution fails explicitly after
    // all supported system and packaged candidates are attempted.
    return undefined;
  }
}

/**
 * Locate ffmpeg/ffprobe without asserting they exist. Callers that can offer a
 * degraded path (the test suite, which reports an explicit skip rather than
 * failing a whole CI lane on an unprovisioned runner) use this; evidence
 * production uses `resolveMediaTools`, which fails closed.
 */
export function findMediaTools(env = process.env) {
  const ffmpeg = [
    env.ELIZA_FFMPEG_BIN,
    "ffmpeg",
    packagedBinary("ffmpeg-static"),
  ].find(executable);
  const ffprobe = [
    env.ELIZA_FFPROBE_BIN,
    "ffprobe",
    packagedBinary("ffprobe-static"),
  ].find(executable);
  if (!ffmpeg || !ffprobe) return undefined;
  return { ffmpeg, ffprobe };
}

export function resolveMediaTools(env = process.env) {
  const tools = findMediaTools(env);
  if (!tools) {
    throw new Error(
      "Voice evidence requires ffmpeg and ffprobe; run bun run evidence:install-tools.",
    );
  }
  return tools;
}

function walkFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  return files;
}

function requireFile(file, label) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing ${label}: ${file || "<unset>"}`);
  }
  if (fs.statSync(file).size === 0)
    throw new Error(`${label} is empty: ${file}`);
  return file;
}

function requireOne(files, predicate, label) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${label}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

function runChecked(bin, args, label) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(requireFile(file, label), "utf8"));
  } catch (error) {
    // error-policy:J3 captured JSON is untrusted input; malformed content is
    // rejected rather than converted into an empty successful record.
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function inspectAudibleMedia(
  file,
  tools = resolveMediaTools(),
  { video = false } = {},
) {
  requireFile(file, "media artifact");
  const probeResult = runChecked(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name",
      "-of",
      "json",
      file,
    ],
    "ffprobe media inspection",
  );
  let probe;
  try {
    probe = JSON.parse(probeResult.stdout);
  } catch (error) {
    // error-policy:J3 ffprobe output is external input and must parse exactly.
    throw new Error(
      `ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  if (video && !streams.some((stream) => stream.codec_type === "video")) {
    throw new Error(`Evidence media has no video stream: ${file}`);
  }
  if (!streams.some((stream) => stream.codec_type === "audio")) {
    throw new Error(`Evidence media has no audio stream: ${file}`);
  }
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration < 0.25) {
    throw new Error(`Evidence media has invalid duration ${duration}: ${file}`);
  }
  const volume = runChecked(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    "audio decode validation",
  );
  const rawMax = String(volume.stderr).match(
    /max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i,
  )?.[1];
  const maxVolumeDb = Number(rawMax);
  if (!Number.isFinite(maxVolumeDb) || maxVolumeDb < -60) {
    throw new Error(
      `Evidence media is silent or below -60 dB (max=${rawMax ?? "missing"}): ${file}`,
    );
  }
  return { duration, maxVolumeDb, streams };
}

export function inspectAudibleMp4(file, tools = resolveMediaTools()) {
  return inspectAudibleMedia(file, tools, { video: true });
}

function inspectAudibleSegment(file, startSeconds, durationSeconds, tools) {
  if (startSeconds < 0 || durationSeconds <= 0) {
    throw new Error(
      `Invalid audio evidence window start=${startSeconds} duration=${durationSeconds}.`,
    );
  }
  const volume = runChecked(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      startSeconds.toFixed(3),
      "-t",
      durationSeconds.toFixed(3),
      "-i",
      file,
      "-map",
      "0:a:0",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    "timed audio evidence decode",
  );
  const rawMax = String(volume.stderr).match(
    /max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i,
  )?.[1];
  const maxVolumeDb = Number(rawMax);
  if (!Number.isFinite(maxVolumeDb) || maxVolumeDb < -60) {
    throw new Error(
      `Timed audio evidence is silent or missing (max=${rawMax ?? "missing"}, start=${startSeconds.toFixed(3)}s).`,
    );
  }
  return { startSeconds, durationSeconds, maxVolumeDb };
}

function audioEnvelope(file, tools, { startSeconds, durationSeconds } = {}) {
  const args = ["-v", "error"];
  if (Number.isFinite(startSeconds)) args.push("-ss", startSeconds.toFixed(3));
  if (Number.isFinite(durationSeconds)) {
    args.push("-t", durationSeconds.toFixed(3));
  }
  args.push(
    "-i",
    file,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "-",
  );
  const result = spawnSync(tools.ffmpeg, args, {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `audio fingerprint decode failed: ${result.error?.message ?? String(result.stderr)}`,
    );
  }
  const sampleCount = Math.floor(result.stdout.byteLength / 4);
  const values = [];
  for (let offset = 0; offset + 80 <= sampleCount; offset += 80) {
    let sum = 0;
    for (let index = offset; index < offset + 80; index += 1) {
      const sample = result.stdout.readFloatLE(index * 4);
      sum += sample * sample;
    }
    values.push(Math.sqrt(sum / 80));
  }
  return values;
}

function normalized(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  if (!Number.isFinite(deviation) || deviation < 1e-5) {
    throw new Error("Audio fingerprint has no usable amplitude modulation.");
  }
  return {
    values: values.map((value) => (value - mean) / deviation),
    mean,
    deviation,
  };
}

export function correlateAudioWindow(
  referenceFile,
  observedFile,
  window,
  tools = resolveMediaTools(),
) {
  const reference = normalized(audioEnvelope(referenceFile, tools));
  const observed = normalized(audioEnvelope(observedFile, tools, window));
  if (reference.values.length < 50 || observed.values.length < 50) {
    throw new Error(
      "Audio fingerprint requires at least 500ms of matched media.",
    );
  }
  const maxLag = Math.min(150, observed.values.length - 50);
  const minimumMatchedBins = Math.max(
    50,
    Math.floor(
      Math.min(reference.values.length, observed.values.length) * 0.65,
    ),
  );
  let best = { correlation: -1, lagMs: 0, matchedDurationMs: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const referenceStart = Math.max(0, -lag);
    const observedStart = Math.max(0, lag);
    const count = Math.min(
      reference.values.length - referenceStart,
      observed.values.length - observedStart,
    );
    if (count < minimumMatchedBins) continue;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < count; index += 1) {
      const left = reference.values[referenceStart + index] ?? 0;
      const right = observed.values[observedStart + index] ?? 0;
      dot += left * right;
      leftNorm += left * left;
      rightNorm += right * right;
    }
    const correlation = dot / Math.sqrt(leftNorm * rightNorm);
    if (correlation > best.correlation) {
      best = { correlation, lagMs: lag * 10, matchedDurationMs: count * 10 };
    }
  }
  const modulationSnrDb = 20 * Math.log10(observed.deviation / observed.mean);
  if (
    !Number.isFinite(best.correlation) ||
    best.correlation < 0.45 ||
    best.matchedDurationMs < minimumMatchedBins * 10 ||
    !Number.isFinite(modulationSnrDb) ||
    modulationSnrDb < -24
  ) {
    throw new Error(
      `Audio fingerprint mismatch (correlation=${best.correlation.toFixed(3)}, ` +
        `matched=${best.matchedDurationMs}ms, ` +
        `modulationSNR=${modulationSnrDb.toFixed(1)}dB).`,
    );
  }
  return { ...best, modulationSnrDb };
}

function assertTrajectory(file) {
  const value = readJson(file, "live trajectory");
  if (
    !Array.isArray(value.llmCalls) ||
    !value.llmCalls.some(
      (call) =>
        typeof call?.model === "string" &&
        call.model.length > 0 &&
        typeof call?.response === "string" &&
        call.response.length > 0,
    )
  ) {
    throw new Error("Live trajectory lacks a concrete model response.");
  }
  return value;
}

function assertNetwork(file) {
  const value = readJson(file, "live network record");
  for (const stage of ["asr", "agent", "tts"]) {
    const status = value?.[stage]?.status;
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      throw new Error(
        `Live voice ${stage} status is not successful: ${status}`,
      );
    }
  }
  for (const key of ["roomId", "messageId", "userMessageId", "trajectoryId"]) {
    if (typeof value?.agent?.[key] !== "string" || !value.agent[key]) {
      throw new Error(`Live network record lacks agent.${key} correlation.`);
    }
  }
  const reference = value?.audioOutput?.reference;
  if (
    !Number.isFinite(Date.parse(reference?.startedAt)) ||
    !Number.isFinite(Date.parse(reference?.endedAt)) ||
    !Number.isFinite(Date.parse(value?.audioOutput?.ttsStartedAt))
  ) {
    throw new Error(
      "Live network record lacks audio-output timing correlation.",
    );
  }
  return value;
}

function assertLoopbackSegments(
  file,
  clockFile,
  network,
  referencePayload,
  ttsPayload,
  tools,
) {
  const clock = readJson(clockFile, "system loopback clock");
  if (
    clock?.source !== "pulse-monitor" ||
    !Number.isFinite(clock?.startedAtMs) ||
    !Number.isFinite(clock?.finishedAtMs) ||
    clock.finishedAtMs <= clock.startedAtMs
  ) {
    throw new Error(
      "System loopback clock is not a completed Pulse monitor capture.",
    );
  }
  const referenceStarted = Date.parse(network.audioOutput.reference.startedAt);
  const referenceEnded = Date.parse(network.audioOutput.reference.endedAt);
  const ttsStarted = Date.parse(network.audioOutput.ttsStartedAt);
  if (
    referenceStarted < clock.startedAtMs ||
    ttsStarted > clock.finishedAtMs + 1_000 ||
    ttsStarted <= referenceEnded
  ) {
    throw new Error(
      "Audio-output timestamps fall outside or out of order in the loopback capture.",
    );
  }
  const referenceStart = Math.max(
    0,
    (referenceStarted - clock.startedAtMs) / 1_000 - 0.2,
  );
  const referenceDuration = (referenceEnded - referenceStarted) / 1_000 + 0.4;
  const ttsStart = Math.max(0, (ttsStarted - clock.startedAtMs) / 1_000 - 0.25);
  return {
    reference: inspectAudibleSegment(
      file,
      referenceStart,
      referenceDuration,
      tools,
    ),
    tts: inspectAudibleSegment(file, ttsStart, 3, tools),
    correlations: {
      reference: correlateAudioWindow(
        referencePayload,
        file,
        {
          startSeconds: referenceStart,
          durationSeconds: referenceDuration,
        },
        tools,
      ),
      tts: correlateAudioWindow(
        ttsPayload,
        file,
        {
          startSeconds: ttsStart,
          durationSeconds: inspectAudibleMedia(ttsPayload, tools).duration + 2,
        },
        tools,
      ),
    },
  };
}

function revision(expected) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error(`Could not resolve an exact evidence revision: ${head}`);
  }
  if (expected && expected !== head) {
    throw new Error(
      `Evidence revision ${expected} does not match HEAD ${head}.`,
    );
  }
  return head;
}

export function snapshotEvidenceFile(
  file,
  root,
  name,
  label = "evidence snapshot input",
) {
  const destination = path.join(root, name);
  let pathStat;
  try {
    pathStat = fs.lstatSync(file);
  } catch (error) {
    // error-policy:J3 an absent snapshot input is translated to the explicit
    // evidence contract; all other filesystem errors remain fatal unchanged.
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${label}: ${file || "<unset>"}`);
    }
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${file}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const sourceFd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  let destinationFd;
  try {
    const before = fs.fstatSync(sourceFd);
    if (
      !before.isFile() ||
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino
    ) {
      throw new Error(
        `${label} changed identity before it could be snapshotted.`,
      );
    }
    destinationFd = fs.openSync(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0;
    for (;;) {
      const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        written += fs.writeSync(
          destinationFd,
          buffer,
          written,
          bytesRead - written,
        );
      }
      copied += bytesRead;
    }
    const after = fs.fstatSync(sourceFd);
    if (
      copied !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${label} changed while it was being snapshotted.`);
    }
    return destination;
  } catch (error) {
    // error-policy:J2 remove incomplete private output, then preserve the
    // descriptor validation or copy failure for the CLI boundary.
    if (destinationFd !== undefined) {
      fs.closeSync(destinationFd);
      destinationFd = undefined;
    }
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd);
    fs.closeSync(sourceFd);
  }
}

export function snapshotEvidenceDirectory(directory, root, name) {
  const destination = path.join(root, name);
  let before;
  try {
    before = fs.lstatSync(directory);
  } catch (error) {
    // error-policy:J3 an absent directory becomes an explicit evidence input
    // failure; other filesystem failures remain fatal unchanged.
    if (error?.code === "ENOENT") {
      throw new Error(
        `Missing evidence snapshot directory: ${directory || "<unset>"}`,
      );
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(
      `Evidence snapshot directory must be a real directory: ${directory}`,
    );
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const entryStat = fs.lstatSync(source);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`Evidence snapshot rejects symlink entry: ${source}`);
      }
      if (entryStat.isDirectory()) {
        snapshotEvidenceDirectory(source, destination, entry.name);
      } else if (entryStat.isFile()) {
        snapshotEvidenceFile(
          source,
          destination,
          entry.name,
          "evidence snapshot file",
        );
      } else {
        throw new Error(
          `Evidence snapshot rejects non-regular entry: ${source}`,
        );
      }
    }
    const after = fs.lstatSync(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(
        `Evidence snapshot directory changed while it was being copied: ${directory}`,
      );
    }
    return destination;
  } catch (error) {
    // error-policy:J2 remove the incomplete private tree, then preserve the
    // identity, entry-type, or descriptor-copy failure for the CLI boundary.
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertFreshCapture(file, startedAt, label) {
  requireFile(file, label);
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error(
      `Evidence has an invalid startedAt timestamp: ${startedAt}`,
    );
  }
  const modifiedAt = fs.statSync(file).mtimeMs;
  if (modifiedAt < startedAtMs - 120_000) {
    throw new Error(
      `${label} predates the live run and may be stale: ${new Date(modifiedAt).toISOString()}`,
    );
  }
}

function projectedMedia(inspected, synchronizationCode) {
  return {
    acousticProjection: ACOUSTIC_PROJECTION,
    durationMs: Math.round(inspected.duration * 1_000),
    maxVolumeMilliDb: Math.round(inspected.maxVolumeDb * 1_000),
    audioStreamCount: inspected.streams.filter(
      (stream) => stream.codec_type === "audio",
    ).length,
    videoStreamCount: inspected.streams.filter(
      (stream) => stream.codec_type === "video",
    ).length,
    synchronizationCode,
  };
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function establishPublicationTrust(parent) {
  if (process.platform === "win32") {
    const configuredRoot = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
    const root = fs.realpathSync(configuredRoot);
    const rootStat = fs.lstatSync(root);
    const relative = path.relative(root, parent);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "Voice evidence output must remain inside the canonical runner temp root.",
      );
    }
    return { root, rootDev: rootStat.dev, rootIno: rootStat.ino };
  }
  const currentUid = process.getuid?.();
  let current = parent;
  while (true) {
    const stat = fs.lstatSync(current);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Voice evidence publication ancestry is not canonical.");
    }
    if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) {
      throw new Error(
        "Voice evidence publication ancestry is owned by another principal.",
      );
    }
    if (writableByOthers && !sticky) {
      throw new Error(
        "Voice evidence publication ancestry is writable by another principal.",
      );
    }
    const container = path.dirname(current);
    if (container === current) break;
    current = container;
  }
  return null;
}

function assertPublicationTrust(parent, trust) {
  if (process.platform !== "win32") {
    establishPublicationTrust(parent);
    return;
  }
  if (!trust) {
    throw new Error("Voice evidence runner temp trust is missing.");
  }
  const rootStat = lstatIfPresent(trust.root);
  const relative = path.relative(trust.root, parent);
  if (
    !rootStat ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.dev !== trust.rootDev ||
    rootStat.ino !== trust.rootIno ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Voice evidence runner temp root changed identity.");
  }
}

function assertOutputDestinationAvailable(outDir) {
  if (!outDir) throw new Error("Voice evidence output directory is required.");
  const requestedDestination = path.resolve(outDir);
  if (requestedDestination === path.parse(requestedDestination).root) {
    throw new Error(
      "Voice evidence output directory cannot be a filesystem root.",
    );
  }
  const requestedDestinationStat = lstatIfPresent(requestedDestination);
  if (requestedDestinationStat?.isSymbolicLink()) {
    throw new Error("Voice evidence output directory cannot be a symlink.");
  }
  if (requestedDestinationStat && !requestedDestinationStat.isDirectory()) {
    throw new Error("Voice evidence output path must be a directory.");
  }
  if (requestedDestinationStat) {
    throw new Error("Voice evidence output directory must not already exist.");
  }
  return requestedDestination;
}

function prepareOutputPublication(outDir) {
  const requestedDestination = assertOutputDestinationAvailable(outDir);
  const requestedParent = path.dirname(requestedDestination);
  fs.mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const parent = fs.realpathSync(requestedParent);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(
      "Voice evidence output parent must be a real directory, not a symlink.",
    );
  }
  const trust = establishPublicationTrust(parent);
  const destination = path.join(parent, path.basename(requestedDestination));
  if (lstatIfPresent(destination)) {
    throw new Error("Voice evidence output directory must not already exist.");
  }
  const stagingPrefix = `.${path.basename(destination)}.voice-evidence-staging-`;
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
  fs.chmodSync(staging, 0o700);
  const stagingStat = fs.lstatSync(staging);
  return {
    destination,
    parent,
    parentStat,
    trust,
    staging,
    stagingPrefix,
    stagingStat,
  };
}

function assertPublicationParentIdentity(publication) {
  const {
    destination,
    parent,
    parentStat: expectedParentStat,
    staging,
  } = publication;
  if (
    path.dirname(destination) !== parent ||
    path.dirname(staging) !== parent
  ) {
    throw new Error("Evidence publication paths escaped their owned parent.");
  }
  const parentStat = lstatIfPresent(parent);
  if (
    !parentStat ||
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.dev !== expectedParentStat.dev ||
    parentStat.ino !== expectedParentStat.ino
  ) {
    throw new Error("Evidence publication parent changed identity.");
  }
  assertPublicationTrust(parent, publication.trust);
  return parentStat;
}

function assertStagingIdentity(publication, { allowMissing = false } = {}) {
  const {
    parent,
    staging,
    stagingPrefix,
    stagingStat: expectedStagingStat,
  } = publication;
  assertPublicationParentIdentity(publication);
  if (
    path.dirname(staging) !== parent ||
    !path.basename(staging).startsWith(stagingPrefix)
  ) {
    throw new Error("Refusing to clean an unowned evidence staging path.");
  }
  const stagingStat = lstatIfPresent(staging);
  if (!stagingStat) {
    if (allowMissing) return undefined;
    throw new Error("Evidence staging directory disappeared.");
  }
  if (
    stagingStat.isSymbolicLink() ||
    !stagingStat.isDirectory() ||
    stagingStat.dev !== expectedStagingStat.dev ||
    stagingStat.ino !== expectedStagingStat.ino
  ) {
    throw new Error("Evidence staging directory changed identity.");
  }
  return stagingStat;
}

function removeOwnedStagingDirectory(publication) {
  if (!assertStagingIdentity(publication, { allowMissing: true })) return;
  const tombstone = `${publication.staging}.cleanup`;
  if (lstatIfPresent(tombstone)) {
    throw new Error("Evidence cleanup tombstone already exists.");
  }
  fs.renameSync(publication.staging, tombstone);
  const tombstoneStat = fs.lstatSync(tombstone);
  if (
    tombstoneStat.isSymbolicLink() ||
    !tombstoneStat.isDirectory() ||
    tombstoneStat.dev !== publication.stagingStat.dev ||
    tombstoneStat.ino !== publication.stagingStat.ino
  ) {
    throw new Error("Evidence cleanup tombstone changed identity.");
  }
  // `fs.rm` unlinks directory symlinks instead of traversing them. The root is
  // the exact inode created above and atomically moved to this private name.
  fs.rmSync(tombstone, { recursive: true, force: true, maxRetries: 2 });
}

function childPath(root, file, label) {
  const relative = path.relative(root, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the evidence staging directory.`);
  }
  return relative;
}

function verifyStagedEvidence(publication, result) {
  assertStagingIdentity(publication);
  const { staging } = publication;
  const manifestRelative = childPath(
    staging,
    result.manifestPath,
    "Evidence manifest",
  );
  const persistedManifest = readJson(result.manifestPath, "evidence manifest");
  if (
    JSON.stringify(persistedManifest) !== JSON.stringify(result.manifest) ||
    persistedManifest.schema !== "eliza_voice_evidence_v1" ||
    persistedManifest.privacy?.publicAudio !==
      "non-intelligible-duration-only-fixed-tone" ||
    persistedManifest.privacy?.privateAudioPublished !== false ||
    !Array.isArray(persistedManifest.artifacts) ||
    persistedManifest.artifacts.length !== result.manifest.artifacts.length
  ) {
    throw new Error(
      "Staged evidence manifest is incomplete or privacy-unsafe.",
    );
  }
  const expectedFiles = new Set([manifestRelative]);
  for (const artifact of persistedManifest.artifacts) {
    if (path.basename(artifact.path) !== artifact.path) {
      throw new Error(`Evidence artifact path is not flat: ${artifact.path}`);
    }
    const file = path.join(staging, artifact.path);
    const relative = childPath(staging, file, "Evidence artifact");
    if (expectedFiles.has(relative)) {
      throw new Error(`Evidence manifest contains a duplicate: ${relative}`);
    }
    const fileStat = fs.lstatSync(file);
    if (
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.size !== artifact.bytes ||
      sha256(file) !== artifact.sha256
    ) {
      throw new Error(`Evidence artifact hash verification failed: ${file}`);
    }
    expectedFiles.add(relative);
  }
  const stagedFiles = fs
    .readdirSync(staging, { withFileTypes: true })
    .map((entry) => {
      const file = path.join(staging, entry.name);
      const fileStat = fs.lstatSync(file);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error(`Evidence staging contains a non-file: ${file}`);
      }
      return childPath(staging, file, "Staged evidence file");
    });
  if (
    stagedFiles.length !== expectedFiles.size ||
    stagedFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error("Evidence staging contains unmanifested public files.");
  }
}

function publishStagedEvidence(publication, result) {
  verifyStagedEvidence(publication, result);
  assertStagingIdentity(publication);
  const publishedResult = {
    ...result,
    mp4: path.join(
      publication.destination,
      childPath(publication.staging, result.mp4, "Evidence MP4"),
    ),
    manifestPath: path.join(
      publication.destination,
      childPath(publication.staging, result.manifestPath, "Evidence manifest"),
    ),
  };
  const currentDestination = lstatIfPresent(publication.destination);
  if (currentDestination) {
    throw new Error(
      "Voice evidence output path appeared before atomic publication.",
    );
  }
  assertPublicationParentIdentity(publication);
  assertStagingIdentity(publication);
  fs.renameSync(publication.staging, publication.destination);
  return publishedResult;
}

function atomicallyPublishEvidence(outDir, build) {
  const publication = prepareOutputPublication(outDir);
  let published = false;
  try {
    const result = build(publication.staging);
    const publishedResult = publishStagedEvidence(publication, result);
    published = true;
    return publishedResult;
  } finally {
    if (!published) removeOwnedStagingDirectory(publication);
  }
}

function writeProof(outDir, kind, head, proof) {
  const file = path.join(outDir, `voice-${kind}-proof.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schema: "eliza_voice_private_input_projection_v1",
        revision: head,
        kind,
        phase: "correlation",
        code: `VOICE_${kind.toUpperCase()}_CORRELATED`,
        checks: proof,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function manifest(outDir, kind, head, media, proof, artifacts) {
  const value = {
    schema: "eliza_voice_evidence_v1",
    issue: 16937,
    kind,
    revision: head,
    generatedAt: new Date().toISOString(),
    privacy: {
      publicAudio: "non-intelligible-duration-only-fixed-tone",
      privateAudioPublished: false,
      sourceFeaturePublished: "duration-only",
    },
    media,
    proof,
    artifacts: artifacts.map(({ file, role }) => ({
      role,
      path: path.basename(file),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    })),
  };
  const manifestPath = path.join(
    outDir,
    `voice-${kind}-evidence-manifest.json`,
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
  return { manifest: value, manifestPath };
}

function mux(video, audioInputs, output, tools) {
  const inputArgs = ["-i", video];
  for (const audio of audioInputs) inputArgs.push("-i", audio);
  const audioFilter =
    audioInputs.length === 1
      ? "[1:a]aresample=48000[a]"
      : `${audioInputs
          .map((_, index) => `[${index + 1}:a]aresample=48000[a${index}]`)
          .join(
            ";",
          )};${audioInputs.map((_, index) => `[a${index}]`).join("")}amix=inputs=${audioInputs.length}:normalize=0[a]`;
  runChecked(
    tools.ffmpeg,
    [
      "-y",
      "-v",
      "error",
      ...inputArgs,
      "-filter_complex",
      audioFilter,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-vf",
      "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      output,
    ],
    "voice recording mux",
  );
}

function projectAcousticSignal(duration, output, tools) {
  if (!Number.isFinite(duration) || duration < 0.25) {
    throw new Error(
      `Cannot project an invalid acoustic duration: ${String(duration)}.`,
    );
  }
  runChecked(
    tools.ffmpeg,
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${ACOUSTIC_PROJECTION.frequencyHz}:sample_rate=${ACOUSTIC_PROJECTION.sampleRateHz}:duration=${duration.toFixed(6)}`,
      "-af",
      "volume=0.25",
      "-ac",
      String(ACOUSTIC_PROJECTION.channels),
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-vn",
      "-c:a",
      "pcm_s16le",
      output,
    ],
    "privacy-safe acoustic projection",
  );
  return output;
}

function transcodeFailures(root, outDir, tools) {
  const files = walkFiles(root);
  const rows = [
    ["mic-denied", /mic-permission-denied/i],
    ["silence", /silent-empty-capture/i],
    ["tts-network-drop", /tts-dropped-mid-stream/i],
  ];
  return rows.map(([slug, pattern]) => {
    const input = requireOne(
      files,
      (file) => path.basename(file) === "video.webm" && pattern.test(file),
      `${slug} failure recording`,
    );
    const output = path.join(outDir, `voice-web-failure-${slug}.mp4`);
    runChecked(
      tools.ffmpeg,
      [
        "-y",
        "-v",
        "error",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      `${slug} failure recording transcode`,
    );
    return output;
  });
}

export function finalizeWebVoiceEvidence(args) {
  assertOutputDestinationAvailable(args.outDir);
  const snapshotRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-voice-web-evidence-"),
  );
  try {
    return finalizeWebVoiceEvidenceSnapshot({
      ...args,
      resultsDir: snapshotEvidenceDirectory(
        args.resultsDir,
        snapshotRoot,
        "results",
      ),
      failureResultsDir: snapshotEvidenceDirectory(
        args.failureResultsDir,
        snapshotRoot,
        "failures",
      ),
      systemLoopback: snapshotEvidenceFile(
        args.systemLoopback,
        snapshotRoot,
        "system-loopback.wav",
        "system loopback",
      ),
      loopbackClock: snapshotEvidenceFile(
        args.loopbackClock,
        snapshotRoot,
        "loopback-clock.json",
      ),
      backendLog: snapshotEvidenceFile(
        args.backendLog,
        snapshotRoot,
        "backend.log",
      ),
      matrixReport: snapshotEvidenceFile(
        args.matrixReport,
        snapshotRoot,
        "matrix-report.json",
      ),
    });
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

export function assertLiveMatrixReport(matrix, head, expectedSession) {
  if (
    matrix?.schema !== "eliza_voice_live_matrix_v2" ||
    matrix?.revision !== head ||
    typeof expectedSession !== "string" ||
    !/^[A-Za-z0-9-]{12,128}$/.test(expectedSession) ||
    matrix?.sessionId !== expectedSession ||
    matrix?.mode !== "run" ||
    matrix?.selection?.filterCount !== 1 ||
    matrix?.selection?.matched !== 1 ||
    matrix?.selection?.errorCode !== null ||
    matrix?.summary?.pass !== 1 ||
    matrix?.summary?.fail !== 0 ||
    matrix?.summary?.pending !== 0 ||
    matrix?.summary?.skip !== 0 ||
    !Array.isArray(matrix?.cells) ||
    matrix.cells.length !== 1 ||
    matrix.cells[0]?.id !== "web.live.cloudflare-roundtrip" ||
    matrix.cells[0]?.platform !== "web" ||
    matrix.cells[0]?.status !== "pass" ||
    matrix.cells[0]?.probe?.available !== true ||
    matrix.cells[0]?.probe?.code !== "WEB_LIVE_READY" ||
    matrix.cells[0]?.execution?.exitCode !== 0 ||
    matrix.cells[0]?.execution?.signalCode !== null ||
    matrix.cells[0]?.execution?.code !== "COMMAND_PASSED"
  ) {
    throw new Error(
      "Live matrix report is not the revision- and session-bound Cloudflare cell pass.",
    );
  }
}

function finalizeWebVoiceEvidenceSnapshot({
  resultsDir,
  failureResultsDir,
  systemLoopback,
  loopbackClock,
  backendLog,
  matrixReport,
  outDir,
  expectedRevision,
  expectedSession,
  tools = resolveMediaTools(),
}) {
  const files = walkFiles(resultsDir);
  const attachment = (pattern, label) =>
    requireOne(files, (file) => pattern.test(file), label);
  const mic = attachment(/voice-live-input(?:-[a-f0-9]+)?\.wav$/, "mic WAV");
  const tts = attachment(
    /voice-live-tts(?:-[a-f0-9]+)?\.(?:wav|mp3|ogg|webm)$/,
    "TTS payload",
  );
  const trajectory = attachment(
    /voice-live-trajectory(?:-[a-f0-9]+)?\.json$/,
    "trajectory",
  );
  const network = attachment(
    /voice-live-network(?:-[a-f0-9]+)?\.json$/,
    "network record",
  );
  const liveRoot = path.dirname(path.dirname(tts));
  const video = requireOne(
    files,
    (file) => path.basename(file) === "video.webm" && file.startsWith(liveRoot),
    "live Playwright video",
  );
  requireOne(
    files,
    (file) => path.basename(file) === "trace.zip" && file.startsWith(liveRoot),
    "live Playwright trace",
  );
  const networkValue = assertNetwork(network);
  const trajectoryValue = assertTrajectory(trajectory);
  if (trajectoryValue.trajectory?.id !== networkValue.agent.trajectoryId) {
    throw new Error(
      "Trajectory detail id does not match the network correlation id.",
    );
  }
  if (
    trajectoryValue.trajectory?.roomId !== networkValue.agent.roomId ||
    trajectoryValue.trajectory?.metadata?.messageId !==
      networkValue.agent.userMessageId
  ) {
    throw new Error(
      "Trajectory metadata does not match the captured room and user message.",
    );
  }
  const matrix = readJson(matrixReport, "live matrix report");
  const head = revision(expectedRevision);
  assertLiveMatrixReport(matrix, head, expectedSession);
  assertFreshCapture(systemLoopback, networkValue.startedAt, "system loopback");
  const loopbackInspection = inspectAudibleMedia(systemLoopback, tools);
  const micInspection = inspectAudibleMedia(mic, tools);
  const ttsInspection = inspectAudibleMedia(tts, tools);
  const audioSegments = assertLoopbackSegments(
    systemLoopback,
    loopbackClock,
    networkValue,
    mic,
    tts,
    tools,
  );
  requireFile(backendLog, "backend log");
  return atomicallyPublishEvidence(outDir, (stagingDir) => {
    const safeLoopback = projectAcousticSignal(
      loopbackInspection.duration,
      path.join(stagingDir, "voice-web-projected-loopback.wav"),
      tools,
    );
    const safeMic = projectAcousticSignal(
      micInspection.duration,
      path.join(stagingDir, "voice-web-projected-input.wav"),
      tools,
    );
    const safeTts = projectAcousticSignal(
      ttsInspection.duration,
      path.join(stagingDir, "voice-web-projected-tts.wav"),
      tools,
    );
    const mp4 = path.join(stagingDir, "voice-web-live-roundtrip.mp4");
    mux(video, [safeLoopback], mp4, tools);
    const inspected = inspectAudibleMp4(mp4, tools);
    const failures = transcodeFailures(failureResultsDir, stagingDir, tools);
    const proof = {
      modelResponsePresent: true,
      networkStagePassCount: 3,
      trajectoryMatched: true,
      roomMatched: true,
      messageMatched: true,
      matrixCellCount: 1,
      matrixPassCount: 1,
      backendEvidencePresent: true,
      referenceAudioMatched: true,
      ttsAudioMatched: true,
      publicAudioProjectedFromDurationOnly: true,
      privateAudioPublished: false,
      failurePathCount: failures.length,
    };
    const proofFile = writeProof(stagingDir, "web", head, proof);
    const artifacts = [
      {
        file: mp4,
        role: "privacy-safe-black-video-plus-projected-loopback-tone",
      },
      {
        file: safeLoopback,
        role: "privacy-safe-projected-loopback-duration-tone",
      },
      {
        file: safeMic,
        role: "privacy-safe-projected-microphone-duration-tone",
      },
      {
        file: safeTts,
        role: "privacy-safe-projected-tts-duration-tone",
      },
      { file: proofFile, role: "privacy-safe-correlation-proof" },
      ...failures.map((file) => ({
        file,
        role: "privacy-safe-black-failure-path-video",
      })),
    ];
    return {
      mp4,
      ...manifest(
        stagingDir,
        "web",
        head,
        {
          ...projectedMedia(
            inspected,
            "SCREEN_AUDIO_SYNCHRONIZATION_NOT_ESTABLISHED",
          ),
          audibleSegmentCount: 2,
          correlatedSignalCount: Object.keys(audioSegments.correlations).length,
        },
        proof,
        artifacts,
      ),
    };
  });
}

function options(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || !rest[index + 1]) {
      throw new Error(
        `Invalid option sequence near ${rest[index] ?? "<end>"}.`,
      );
    }
    values[rest[index].slice(2)] = path.resolve(REPO_ROOT, rest[index + 1]);
  }
  return { command, values };
}

function main() {
  const { command, values } = options(process.argv.slice(2));
  const common = {
    outDir: values.out,
    backendLog: values.backend,
    expectedRevision: process.env.ELIZA_VOICE_EVIDENCE_REVISION,
    expectedSession: process.env.ELIZA_VOICE_MATRIX_SESSION_ID,
  };
  const result =
    command === "web"
      ? finalizeWebVoiceEvidence({
          ...common,
          resultsDir: values.results,
          failureResultsDir: values.failures,
          systemLoopback: values.loopback,
          loopbackClock: values["loopback-clock"],
          matrixReport: values.matrix,
        })
      : (() => {
          throw new Error(
            "Usage: voice-evidence-media.ts web --<artifact> <path> ...",
          );
        })();
  console.log(
    `[voice-evidence] phase=finalize status=passed code=EVIDENCE_READY artifacts=${result.manifest.artifacts.length}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 CLI boundary — incomplete evidence exits non-zero.
    void error;
    console.error(
      "[voice-evidence] phase=finalize status=failed code=EVIDENCE_REJECTED",
    );
    process.exitCode = 1;
  }
}
