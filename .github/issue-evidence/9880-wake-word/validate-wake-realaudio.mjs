/**
 * Real-audio validation for the name-aware wake word (issue #9880).
 *
 * Closes a genuine acoustic→ASR→matcher loop on macOS:
 *   say (real TTS, audible through the speakers)  →  16 kHz WAV (ffmpeg)
 *   →  whisper.cpp Metal ASR (the repo's built whisper-cli)  →  real transcript
 *   →  matchWakeName() (the shipped UI matcher)  →  PASS/FAIL vs expectation.
 *
 * This is the same matcher the app uses at the wake confirmation stage, run on
 * actual transcribed speech rather than hand-typed strings. Run while screen +
 * mic are being recorded so the spoken phrases are audible in the evidence.
 *
 *   bun .github/issue-evidence/9880-wake-word/validate-wake-realaudio.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchWakeName } from "../../../packages/ui/src/voice/wake-name-match.ts";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const WHISPER = join(
  REPO,
  "plugins/plugin-local-inference/native/build-whisper/bin/whisper-cli",
);
const MODEL =
  process.env.WHISPER_MODEL ??
  join(
    process.env.SCRATCH ??
      "/private/tmp/claude-501/-Users-shawwalters-eliza-workspace-eliza-eliza/3ef0625f-bea4-482b-83e1-946acc991905/scratchpad",
    "ggml-base.en.bin",
  );

const work = mkdtempSync(join(tmpdir(), "wake-realaudio-"));

/** Speak `phrase` aloud + to a 16 kHz wav, then transcribe with whisper.cpp. */
function transcribe(phrase, idx) {
  const aiff = join(work, `c${idx}.aiff`);
  const wav = join(work, `c${idx}.wav`);
  // --interactive keeps it audible through the speakers for the recording.
  execFileSync("say", ["-o", aiff, phrase]);
  execFileSync("say", [phrase]); // audible pass for the video
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
  const out = execFileSync(WHISPER, ["-m", MODEL, "-f", wav, "-nt"], {
    encoding: "utf8",
  });
  return out.trim();
}

// phrase spoken · character name in settings · expect a wake match? · expected command substring
const CASES = [
  ["Hey Eliza, what is the weather today?", "eliza", true, "weather"],
  ["Eliza turn on the lights", "eliza", true, "lights"],
  // Renamed character — the wake follows the new name and ignores the old one.
  ["Hey Ada, what is on my calendar", "ada", true, "calendar"],
  ["Hey Ada, what is on my calendar", "eliza", false, ""],
  // Negative — no wake phrase at all.
  ["Hey there, how are you doing", "eliza", false, ""],
];

console.log(`\n=== Real-audio wake-word validation (#9880) ===`);
console.log(
  `ASR: whisper.cpp Metal · matcher: matchWakeName (shipped UI code)\n`,
);

let pass = 0;
const rows = [];
CASES.forEach(([phrase, name, expectMatch, expectCmd], i) => {
  const transcript = transcribe(phrase, i);
  const m = matchWakeName(transcript, name);
  const ok =
    m.matched === expectMatch &&
    (!expectMatch || m.command.includes(expectCmd));
  if (ok) pass += 1;
  rows.push({
    spoken: phrase,
    name,
    transcript,
    matched: m.matched,
    command: m.command,
    expectMatch,
    ok,
  });
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  name="${name}"`);
  console.log(`   spoken:     "${phrase}"`);
  console.log(`   ASR heard:  "${transcript}"`);
  console.log(
    `   matched=${m.matched} (expected ${expectMatch})  command="${m.command}"\n`,
  );
});

console.log(`=== ${pass}/${CASES.length} real-audio cases passed ===\n`);
process.exit(pass === CASES.length ? 0 : 1);
