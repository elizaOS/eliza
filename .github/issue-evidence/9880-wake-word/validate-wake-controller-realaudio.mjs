/**
 * Real-audio validation for the unified WakeController two-stage path
 * (issue #9880, §D). Where `validate-wake-realaudio.mjs` validated the bare
 * name-matcher, this drives the WHOLE controller decision on real transcribed
 * speech:
 *
 *   say (real TTS, audible)  →  16 kHz WAV (ffmpeg)
 *   →  whisper.cpp Metal ASR (the repo's built whisper-cli)  →  real transcript
 *   →  stage-a-candidate → stage-b-transcript through wakeControllerReducer
 *   →  assert the emitted WakeDetection (matched / command / path).
 *
 * The two-stage path is the one that actually consumes ASR (the head fast-path
 * skips it; Swabble is OS-ASR passthrough), so real audio is exactly what
 * validates it. The path-selection matrix is asserted directly below.
 *
 *   bun .github/issue-evidence/9880-wake-word/validate-wake-controller-realaudio.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialWakeControllerState,
  selectWakePath,
  wakeControllerReducer,
} from "../../../packages/ui/src/voice/wake-controller.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const WHISPER = join(
  REPO,
  "plugins/plugin-local-inference/native/build-whisper/bin/whisper-cli",
);
const MODEL =
  process.env.WHISPER_MODEL ??
  join(process.env.HOME, ".cache/eliza/whisper/ggml-base.en.bin");

const HEADS = new Set(["eliza"]);
const FUSED = { openWakeWord: true, asrConfirm: true, swabble: true };
const WEB = { openWakeWord: false, asrConfirm: false, swabble: true };

const work = mkdtempSync(join(tmpdir(), "wake-controller-realaudio-"));

/** Speak `phrase` aloud + to a 16 kHz wav, then transcribe with whisper.cpp. */
function transcribe(phrase, idx) {
  const aiff = join(work, `c${idx}.aiff`);
  const wav = join(work, `c${idx}.wav`);
  execFileSync("say", ["-o", aiff, phrase]);
  if (!process.env.NO_AUDIO) execFileSync("say", [phrase]); // audible for the video
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    aiff,
    "-ar",
    "16000",
    "-ac",
    "1",
    wav,
  ]);
  return execFileSync(WHISPER, ["-m", MODEL, "-f", wav, "-nt"], {
    encoding: "utf8",
  }).trim();
}

/** Drive the full two-stage controller: candidate → real transcript → emit. */
function runTwoStage(config, transcript) {
  let s = initialWakeControllerState();
  ({ state: s } = wakeControllerReducer(
    s,
    { type: "stage-a-candidate", now: 1000 },
    config,
  ));
  if (s.phase !== "confirming")
    throw new Error(
      `candidate did not arm a confirm window on ${selectWakePath(config)}`,
    );
  return wakeControllerReducer(
    s,
    { type: "stage-b-transcript", transcript, now: 1200 },
    config,
  ).emit;
}

let pass = 0;
let total = 0;

// ── Part 1: path-selection matrix (no audio) ───────────────────────────────
console.log(`\n=== WakeController path selection (#9880 §D) ===`);
const pathCases = [
  ["eliza", FUSED, "head-fast-path"],
  ["ada", FUSED, "two-stage-asr"],
  ["nova", FUSED, "two-stage-asr"],
  ["ada", WEB, "swabble-fallback"],
];
for (const [name, caps, want] of pathCases) {
  total += 1;
  const got = selectWakePath({
    characterName: name,
    trainedHeads: HEADS,
    capabilities: caps,
  });
  const ok = got === want;
  if (ok) pass += 1;
  console.log(
    `${ok ? "✅" : "❌"} name="${name}" caps=${caps === FUSED ? "fused" : "web"} → ${got} (want ${want})`,
  );
}

// ── Part 2: two-stage confirmation on REAL transcribed speech ───────────────
console.log(`\n=== Two-stage ASR confirmation on real audio ===`);
console.log(
  `ASR: whisper.cpp Metal · reducer: wakeControllerReducer (shipped UI code)\n`,
);

// phrase spoken · character name · expect a confirmed wake? · command substring
const audioCases = [
  // Prefix + short (3-char) name.
  ["Hey Ada, what is on my calendar", "ada", true, "calendar"],
  // BARE (prefix-less) name that is distinctive enough (>= 4 chars) to fire.
  ["Samantha, turn on the lights", "samantha", true, "lights"],
  // Rename to a different name — the wake follows it.
  ["Hey Nova, set a timer for ten minutes", "nova", true, "timer"],
  // Wrong name in the transcript — must NOT confirm.
  ["Hey Eliza, what is on my calendar", "ada", false, ""],
  // No wake phrase at all.
  ["Hey there, how are you doing", "ada", false, ""],
  // BARE short (3-char) name with no prefix: correctly REJECTED — too short to
  // be distinctive, the matcher's false-positive guard (wake-name-match.ts).
  ["Ada, turn on the lights", "ada", false, ""],
];

for (let i = 0; i < audioCases.length; i++) {
  const [phrase, name, expectMatch, expectCmd] = audioCases[i];
  total += 1;
  const transcript = transcribe(phrase, i);
  const config = {
    characterName: name,
    trainedHeads: HEADS,
    capabilities: FUSED,
  };
  const emit = runTwoStage(config, transcript);
  const matched = emit != null;
  const ok =
    matched === expectMatch &&
    (!expectMatch ||
      (emit.command.includes(expectCmd) && emit.path === "two-stage-asr"));
  if (ok) pass += 1;
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  name="${name}"`);
  console.log(`   spoken:     "${phrase}"`);
  console.log(`   ASR heard:  "${transcript}"`);
  console.log(
    `   confirmed=${matched} (expected ${expectMatch})  ${matched ? `command="${emit.command}" path=${emit.path}` : ""}\n`,
  );
}

console.log(`=== ${pass}/${total} controller cases passed ===\n`);
process.exit(pass === total ? 0 : 1);
