#!/usr/bin/env node
/**
 * Runs packaged desktop voice acceptance inside one synchronized hardware capture.
 *
 * The recorder uses one ffmpeg process for screen, physical microphone, and
 * system-output loopback. It passes a fresh session nonce to the child matrix
 * command, then emits separate media files plus a clock/hash provenance record.
 */

import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  classifyPhysicalMicrophoneEndpoint,
  resolveMediaTools,
} from "./voice-evidence-media.mjs";

export { classifyPhysicalMicrophoneEndpoint };

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function required(value, label) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function captureInputs(platform, env = process.env) {
  const microphone = required(
    env.ELIZA_VOICE_HARDWARE_MIC_DEVICE,
    "ELIZA_VOICE_HARDWARE_MIC_DEVICE",
  );
  const speakerLoopback = required(
    env.ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE,
    "ELIZA_VOICE_HARDWARE_SPEAKER_LOOPBACK_DEVICE",
  );
  const browserMicrophone = required(
    env.ELIZA_VOICE_BROWSER_MIC_DEVICE_ID,
    "ELIZA_VOICE_BROWSER_MIC_DEVICE_ID",
  );
  const browserSpeaker = required(
    env.ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID,
    "ELIZA_VOICE_BROWSER_SPEAKER_DEVICE_ID",
  );
  if (microphone === speakerLoopback) {
    throw new Error(
      "Physical microphone and speaker loopback must be distinct.",
    );
  }
  if (browserMicrophone === browserSpeaker) {
    throw new Error(
      "Browser microphone and speaker device ids must be distinct.",
    );
  }
  if (platform === "darwin") {
    const screen = required(
      env.ELIZA_VOICE_HARDWARE_SCREEN_DEVICE,
      "ELIZA_VOICE_HARDWARE_SCREEN_DEVICE",
    );
    return {
      screen,
      microphone,
      speakerLoopback,
      browserMicrophone,
      browserSpeaker,
      args: [
        "-f",
        "avfoundation",
        "-framerate",
        "30",
        "-i",
        `${screen}:none`,
        "-f",
        "avfoundation",
        "-i",
        `none:${microphone}`,
        "-f",
        "avfoundation",
        "-i",
        `none:${speakerLoopback}`,
      ],
    };
  }
  if (platform === "win32") {
    return {
      screen: "desktop",
      microphone,
      speakerLoopback,
      browserMicrophone,
      browserSpeaker,
      args: [
        "-f",
        "gdigrab",
        "-framerate",
        "30",
        "-i",
        "desktop",
        "-f",
        "dshow",
        "-i",
        `audio=${microphone}`,
        "-f",
        "dshow",
        "-i",
        `audio=${speakerLoopback}`,
      ],
    };
  }
  throw new Error(
    `Hardware capture supports darwin or win32, not ${platform}.`,
  );
}

export function assertConfiguredDevicesListed(platform, inputs, listing) {
  const normalized = String(listing);
  const resolved = {};
  for (const [label, device] of [
    ["microphone", inputs.microphone],
    ["speaker loopback", inputs.speakerLoopback],
    ...(platform === "darwin" ? [["screen", inputs.screen]] : []),
  ]) {
    let section = "";
    const expectedSection = label === "screen" ? "video" : "audio";
    const candidates = normalized.split(/\r?\n/).flatMap((line) => {
      if (/video devices:/i.test(line)) section = "video";
      if (/audio devices:/i.test(line)) section = "audio";
      if (platform === "darwin" && section && section !== expectedSection) {
        return [];
      }
      const quotedLabel = line.match(/"([^"]+)"/)?.[1];
      const indexed = line.match(/\[(\d+)\]\s*(?:"([^"]+)"|(.+?))\s*$/);
      const enumeratedLabel = (
        quotedLabel ??
        indexed?.[2] ??
        indexed?.[3] ??
        ""
      ).trim();
      return [{ line, index: indexed?.[1], enumeratedLabel }];
    });
    const matches = candidates.filter(
      ({ line, index, enumeratedLabel }) =>
        index === String(device) ||
        enumeratedLabel === String(device) ||
        line.includes(`"${device}"`),
    );
    if (matches.length === 0) {
      throw new Error(
        `Configured ${label} device ${device} is absent from ffmpeg enumeration.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Configured ${label} device ${device} is ambiguous in ffmpeg enumeration; use a unique device identity.`,
      );
    }
    const [candidate] = matches;
    resolved[label] = candidate.enumeratedLabel || String(device);
  }
  if (
    resolved.microphone.trim().toLowerCase() ===
    resolved["speaker loopback"].trim().toLowerCase()
  ) {
    throw new Error(
      "Enumerated physical microphone and speaker loopback resolve to the same device.",
    );
  }
  return resolved;
}

function parse(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error(
      "Usage: desktop-voice-hardware-capture.mjs --platform darwin|win32 --out <dir> -- <matrix command...>",
    );
  }
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  let platform = "";
  let outDir = "";
  for (let index = 0; index < options.length; index += 2) {
    if (options[index] === "--platform") platform = options[index + 1] ?? "";
    else if (options[index] === "--out") outDir = options[index + 1] ?? "";
    else
      throw new Error(`Unknown capture option ${options[index] ?? "<end>"}.`);
  }
  return {
    platform: required(platform, "--platform"),
    outDir: path.resolve(REPO_ROOT, required(outDir, "--out")),
    command,
  };
}

function run(file, args) {
  const result = spawnSync(file, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${result.status}.`);
  }
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let forced = false;
    let timeout = setTimeout(() => {
      forced = true;
      child.kill("SIGTERM");
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error("ffmpeg did not finalize the hardware capture in time."),
        );
      }, 5_000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!forced && (code === 0 || code === 255)) resolve();
      else if (forced) {
        reject(
          new Error("ffmpeg required forced termination during finalization."),
        );
      } else {
        reject(new Error(`ffmpeg hardware capture exited ${code}.`));
      }
    });
  });
}

async function main() {
  const { platform, outDir, command } = parse(process.argv.slice(2));
  const tools = resolveMediaTools();
  const inputs = captureInputs(platform);
  const backendSource = path.resolve(
    required(
      process.env.ELIZA_VOICE_DESKTOP_BACKEND_LOG,
      "ELIZA_VOICE_DESKTOP_BACKEND_LOG",
    ),
  );
  const deviceProbe = spawnSync(
    tools.ffmpeg,
    platform === "darwin"
      ? [
          "-hide_banner",
          "-f",
          "avfoundation",
          "-list_devices",
          "true",
          "-i",
          "",
        ]
      : ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (deviceProbe.error) throw deviceProbe.error;
  const enumeratedDevices = assertConfiguredDevicesListed(
    platform,
    inputs,
    `${deviceProbe.stdout ?? ""}\n${deviceProbe.stderr ?? ""}`,
  );
  const microphoneProvenance = classifyPhysicalMicrophoneEndpoint(
    platform,
    inputs.microphone,
    enumeratedDevices.microphone,
  );

  fs.mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, "synchronized-capture.mkv");
  const startedAt = new Date().toISOString();
  const sessionId = `voice-${crypto.randomUUID()}`;
  const backendStartOffset = fs.existsSync(backendSource)
    ? fs.statSync(backendSource).size
    : 0;
  const recorder = spawn(
    tools.ffmpeg,
    [
      "-y",
      "-v",
      "warning",
      ...inputs.args,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "2:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "pcm_s16le",
      archive,
    ],
    { cwd: REPO_ROOT, stdio: ["pipe", "inherit", "inherit"] },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, 1_000);
    recorder.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    recorder.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`ffmpeg exited during capture preflight (${code}).`));
    });
  });

  let childCode = 1;
  try {
    const child = spawn(command[0], command.slice(1), {
      cwd: REPO_ROOT,
      env: { ...process.env, ELIZA_VOICE_CAPTURE_SESSION_ID: sessionId },
      stdio: "inherit",
    });
    childCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (!recorder.stdin.destroyed) {
      recorder.stdin.write("q\n");
      recorder.stdin.end();
    }
    await waitForClose(recorder, 15_000);
  }
  const finishedAt = new Date().toISOString();
  if (!fs.existsSync(backendSource)) {
    throw new Error("Desktop backend log was not created during the run.");
  }
  const backendEndOffset = fs.statSync(backendSource).size;
  if (backendEndOffset <= backendStartOffset) {
    throw new Error(
      "Desktop backend log did not grow during the captured run.",
    );
  }
  const backendDeltaBytes = backendEndOffset - backendStartOffset;
  if (backendDeltaBytes > 64 * 1024 * 1024) {
    throw new Error(
      "Desktop backend session log exceeds the 64 MiB evidence bound.",
    );
  }
  const backendSessionLog = path.join(outDir, "backend-session.log");
  const backendDelta = Buffer.allocUnsafe(backendDeltaBytes);
  const backendFd = fs.openSync(backendSource, "r");
  try {
    const bytesRead = fs.readSync(
      backendFd,
      backendDelta,
      0,
      backendDelta.length,
      backendStartOffset,
    );
    if (bytesRead !== backendDelta.length) {
      throw new Error(
        "Desktop backend log changed while its session delta was read.",
      );
    }
  } finally {
    fs.closeSync(backendFd);
  }
  fs.writeFileSync(backendSessionLog, backendDelta);

  const screen = path.join(outDir, "screen.mp4");
  const microphone = path.join(outDir, "microphone.wav");
  const speakerLoopback = path.join(outDir, "speaker-loopback.wav");
  run(tools.ffmpeg, [
    "-y",
    "-v",
    "error",
    "-i",
    archive,
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "copy",
    screen,
  ]);
  for (const [stream, output] of [
    ["0:a:0", microphone],
    ["0:a:1", speakerLoopback],
  ]) {
    run(tools.ffmpeg, [
      "-y",
      "-v",
      "error",
      "-i",
      archive,
      "-map",
      stream,
      "-c:a",
      "pcm_s16le",
      output,
    ]);
  }
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const clock = (file) => ({ startedAt, finishedAt, sha256: sha256(file) });
  fs.writeFileSync(
    path.join(outDir, "capture-provenance.json"),
    `${JSON.stringify(
      {
        kind: "physical-hardware",
        revision,
        sessionId,
        microphone: microphoneProvenance,
        speakerLoopback: {
          kind: "system-output-loopback",
          device: inputs.speakerLoopback,
        },
        browserDevices: {
          microphone: inputs.browserMicrophone,
          speaker: inputs.browserSpeaker,
        },
        captures: {
          screen: clock(screen),
          microphone: clock(microphone),
          speakerLoopback: clock(speakerLoopback),
          backend: {
            ...clock(backendSessionLog),
            source: backendSource,
            startOffset: backendStartOffset,
            endOffset: backendEndOffset,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (childCode !== 0) process.exitCode = childCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    // error-policy:J1 the CLI boundary exits non-zero on incomplete capture.
    console.error(
      `[desktop-voice-capture] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
