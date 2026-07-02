#!/usr/bin/env node
/**
 * run-fused-parity.mjs — Phase-1 fused-voice parity gate driver.
 *
 * Stages a bundle dir whose wake/ speaker/ diariz/ subdirs point at the
 * real GGUFs, compiles fused-vs-standalone-parity.c, and runs it against
 * BOTH libelizainference (the fused fork lib) AND the standalone
 * libwakeword / libvoice_classifier so the harness can compare outputs.
 *
 * Inputs (override via env):
 *   FUSED_SO        path to libelizainference.so
 *   WAKEWORD_SO     path to libwakeword.so      (standalone reference)
 *   VOICE_CLASS_SO  path to libvoice_classifier.so (standalone reference)
 *   SILERO_VAD_SO   path to libsilero_vad.so    (standalone reference)
 *   WESPEAKER_GGUF  path to wespeaker-resnet34-lm.gguf
 *   PYANNOTE_GGUF   path to pyannote-segmentation-3.0.gguf
 *   SILERO_GGUF     path to silero-vad-v5.gguf
 *   WAKE_DIR        dir holding hey-eliza.{melspec,embedding,classifier}.gguf
 *   WAKE_HEAD       wake-word head name (default hey-eliza)
 *   FREEMAN_WAV     real-speech wav (22050 Hz mono → resampled to 16 k)
 *
 * Exit 0 = parity holds for every model.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function firstExisting(cands) {
  for (const c of cands) if (c && fs.existsSync(c)) return path.resolve(c);
  return null;
}

const FUSED_SO = firstExisting([
  process.env.FUSED_SO,
  path.join(os.homedir(), ".cache/eliza-fused-build/bin/libelizainference.so"),
]);
const WAKEWORD_SO = firstExisting([
  process.env.WAKEWORD_SO,
  path.join(
    repoRoot,
    "packages/native/plugins/wakeword-cpp/build/libwakeword.so",
  ),
]);
const VOICE_CLASS_SO = firstExisting([
  process.env.VOICE_CLASS_SO,
  path.join(
    repoRoot,
    "packages/native/plugins/voice-classifier-cpp/build/libvoice_classifier.so",
  ),
]);
const SILERO_VAD_SO = firstExisting([
  process.env.SILERO_VAD_SO,
  path.join(
    repoRoot,
    "packages/native/plugins/silero-vad-cpp/build/libsilero_vad.so",
  ),
]);
const WESPEAKER_GGUF = firstExisting([
  process.env.WESPEAKER_GGUF,
  "/tmp/voice-models/wespeaker-resnet34-lm.gguf",
]);
const PYANNOTE_GGUF = firstExisting([
  process.env.PYANNOTE_GGUF,
  "/tmp/voice-models/pyannote-segmentation-3.0.gguf",
]);
const SILERO_GGUF = firstExisting([
  process.env.SILERO_GGUF,
  "/tmp/voice-models/silero-vad-v5.gguf",
]);
const WAKE_DIR = firstExisting([
  process.env.WAKE_DIR,
  "/tmp/wakeword/gguf_norescale",
]);
const WAKE_HEAD = process.env.WAKE_HEAD || "hey-eliza";
const FREEMAN_WAV = firstExisting([
  process.env.FREEMAN_WAV,
  path.join(
    repoRoot,
    "plugins/plugin-local-inference/native/audio-fixtures/freeman.wav",
  ),
]);

const missing = [];
for (const [k, v] of Object.entries({
  FUSED_SO,
  WAKEWORD_SO,
  VOICE_CLASS_SO,
  SILERO_VAD_SO,
  WESPEAKER_GGUF,
  PYANNOTE_GGUF,
  SILERO_GGUF,
  WAKE_DIR,
  FREEMAN_WAV,
})) {
  if (!v) missing.push(k);
}
if (missing.length) {
  console.error(`[parity] missing required inputs: ${missing.join(", ")}`);
  process.exit(2);
}

/* Stage a bundle dir for the fused resolver. */
const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "fused-parity-bundle-"));
for (const sub of ["wake", "speaker", "diariz", "vad"]) {
  fs.mkdirSync(path.join(bundle, sub), { recursive: true });
}
for (const kind of ["melspec", "embedding", "classifier"]) {
  fs.symlinkSync(
    path.join(WAKE_DIR, `${WAKE_HEAD}.${kind}.gguf`),
    path.join(bundle, "wake", `${WAKE_HEAD}.${kind}.gguf`),
  );
}
fs.symlinkSync(
  WESPEAKER_GGUF,
  path.join(bundle, "speaker", path.basename(WESPEAKER_GGUF)),
);
fs.symlinkSync(
  PYANNOTE_GGUF,
  path.join(bundle, "diariz", path.basename(PYANNOTE_GGUF)),
);
fs.symlinkSync(
  SILERO_GGUF,
  path.join(bundle, "vad", path.basename(SILERO_GGUF)),
);

/* Compile the harness. */
const src = path.join(here, "fused-vs-standalone-parity.c");
const bin = path.join(bundle, "parity");
const cc = process.env.CC || "cc";
console.log(`[parity] compile ${src}`);
const compile = spawnSync(
  cc,
  ["-O2", "-std=c11", src, "-o", bin, "-ldl", "-lm"],
  { stdio: "inherit" },
);
if (compile.status !== 0) {
  console.error("[parity] compile failed");
  process.exit(3);
}

console.log(`[parity] bundle=${bundle}`);
console.log(`[parity] fused=${FUSED_SO}`);
console.log(`[parity] standalone ww=${WAKEWORD_SO}`);
console.log(`[parity] standalone vc=${VOICE_CLASS_SO}`);
console.log(`[parity] standalone vad=${SILERO_VAD_SO}\n`);

const run = spawnSync(
  bin,
  [
    FUSED_SO,
    WAKEWORD_SO,
    VOICE_CLASS_SO,
    SILERO_VAD_SO,
    bundle,
    FREEMAN_WAV,
    WESPEAKER_GGUF,
    PYANNOTE_GGUF,
    SILERO_GGUF,
    WAKE_HEAD,
  ],
  { stdio: "inherit" },
);

try {
  fs.rmSync(bundle, { recursive: true, force: true });
} catch {}
process.exit(run.status ?? 1);
