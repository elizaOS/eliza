#!/usr/bin/env bun
/**
 * Build `cache/voice-preset-<voiceId>.bin` — a frozen OmniVoice voice
 * preset (ELZ2 v2 format) for a single voice.
 *
 * R6 §3.3 freeze procedure end-to-end:
 *   1. Read the source corpus directory of WAV+TXT pairs (defaults to
 *      `packages/training/data/voice/same/`).
 *   2. Pick one or more reference clips, decode them to 24 kHz mono fp32,
 *      and concatenate up to a maximum reference duration (default ≤15 s,
 *      OmniVoice accepts up to ~30 s).
 *   3. Run the bundled OmniVoice tokenizer (HuBERT semantic + RVQ codec)
 *      via the FFI `encodeReference` entrypoint to produce
 *      `int32[K=8, ref_T]` tokens.
 *   4. Concatenate the matching transcripts as `ref_text`.
 *   5. Persist `(refAudioTokens, refText, instruct, metadata)` as ELZ2 v2
 *      under `<bundle>/cache/voice-preset-<voiceId>.bin`.
 *   6. Roundtrip-validate the written file via `readVoicePresetFile`.
 *
 * Per the brief (§1Q3-Q4), the entry path is:
 *
 *   bun packages/app-core/scripts/voice/freeze-voice.mjs \
 *     --voice same \
 *     --ai-voices-dir packages/training/data/voice/same/audio/ \
 *     --out <bundle>/cache/voice-preset-same.bin \
 *     --instruct "young adult female, warm, soft, neutral us-american"
 *
 * Flags:
 *   --voice <id>           Voice identifier (default: `same`).
 *                          Used as the output filename suffix.
 *   --corpus <dir>         Corpus directory containing audio/*.wav +
 *                          manifest.jsonl (or audio/*.txt transcripts).
 *                          Conventional path: packages/training/data/voice/<voice>/.
 *   --ai-voices-dir <dir>  Alias for --corpus pointing at the audio/
 *                          sub-directory.
 *   --out <path>           Output file (default:
 *                          `<bundle>/cache/voice-preset-<voice>.bin`).
 *   --bundle <dir>         Bundle root for default `--out` resolution.
 *                          Default: `~/.eliza/local-inference/models/eliza-1-2b.bundle`.
 *   --instruct <text>      Resolved VoiceDesign instruct string.
 *                          Default: empty (model picks from reference audio).
 *   --max-seconds <n>      Max reference duration in seconds (default 15).
 *   --skip-encode          Skip the FFI encode call. Useful for dev when
 *                          no fused libelizainference is available — the
 *                          preset is written with refText + instruct but
 *                          empty refAudioTokens.
 *   --dylib <path>         Override libelizainference path. Default:
 *                          autoresolve via `loadElizaInferenceFfi`.
 *   --dry-run              Print the plan + sizes, don't write the file.
 *
 * Exit codes:
 *   0  success
 *   1  generic failure (validation, IO, encode error)
 *   2  bad CLI args
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const { readVoicePresetFile, writeVoicePresetFileV2 } = await import(
  "../../../../plugins/plugin-local-inference/src/services/voice/voice-preset-format.ts"
);

const DEFAULT_BUNDLE = path.join(
  homedir(),
  ".eliza",
  "local-inference",
  "models",
  "eliza-1-2b.bundle",
);
const DEFAULT_MAX_SECONDS = 15;

function usage(code = 0) {
  console.log(
    [
      "Usage: bun packages/app-core/scripts/voice/freeze-voice.mjs [flags]",
      "",
      "Flags:",
      "  --voice <id>           Voice id (default: same)",
      "  --corpus <dir>         Corpus root (with manifest.jsonl or audio/*.txt)",
      "  --ai-voices-dir <dir>  Alias for the audio/ sub-directory",
      "  --out <path>           Output file (default <bundle>/cache/voice-preset-<voice>.bin)",
      "  --bundle <dir>         Bundle root (default eliza-1-2b.bundle)",
      "  --instruct <text>      VoiceDesign instruct string",
      "  --max-seconds <n>      Max reference seconds (default 15)",
      "  --skip-encode          Skip FFI encode (writes refText+instruct only)",
      "  --dylib <path>         Override libelizainference path",
      "  --dry-run              Plan only, don't write",
      "  --help                 This message",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    voice: "same",
    corpus: null,
    audioDir: null,
    out: null,
    bundle: DEFAULT_BUNDLE,
    instruct: "",
    maxSeconds: DEFAULT_MAX_SECONDS,
    skipEncode: false,
    dylib: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--voice":
        args.voice = argv[++i];
        break;
      case "--corpus":
        args.corpus = argv[++i];
        break;
      case "--ai-voices-dir":
        args.audioDir = argv[++i];
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--bundle":
        args.bundle = argv[++i];
        break;
      case "--instruct":
        args.instruct = argv[++i];
        break;
      case "--max-seconds":
        args.maxSeconds = Number.parseFloat(argv[++i]);
        break;
      case "--skip-encode":
        args.skipEncode = true;
        break;
      case "--dylib":
        args.dylib = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        usage(0);
        break;
      default:
        console.error(`[freeze-voice] unknown flag: ${a}`);
        usage(2);
    }
  }
  if (!args.voice || !/^[A-Za-z0-9._-]+$/.test(args.voice)) {
    console.error(
      `[freeze-voice] --voice must be a path-safe segment (got: ${JSON.stringify(args.voice)})`,
    );
    process.exit(2);
  }
  if (!Number.isFinite(args.maxSeconds) || args.maxSeconds <= 0) {
    console.error(`[freeze-voice] --max-seconds must be positive`);
    process.exit(2);
  }
  if (!args.out) {
    args.out = path.join(
      args.bundle,
      "cache",
      `voice-preset-${args.voice}.bin`,
    );
  }
  if (!args.corpus && !args.audioDir) {
    args.corpus = path.join(
      process.cwd(),
      "packages",
      "training",
      "data",
      "voice",
      args.voice,
    );
  }
  return args;
}

/** Minimal RIFF/WAVE reader for the standard 16-bit PCM mono case the
 *  same corpus ships (verified via `audit_same.sh` per R12). */
function readWavMonoFloat(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 44) {
    throw new Error(`[freeze-voice] WAV truncated: ${filePath}`);
  }
  if (buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`[freeze-voice] not a RIFF file: ${filePath}`);
  }
  if (buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`[freeze-voice] not a WAVE file: ${filePath}`);
  }
  let pos = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(pos),
        channels: buf.readUInt16LE(pos + 2),
        sampleRate: buf.readUInt32LE(pos + 4),
        bitsPerSample: buf.readUInt16LE(pos + 14),
      };
    } else if (id === "data") {
      dataOff = pos;
      dataLen = sz;
      break;
    }
    pos += sz;
    if (sz % 2 === 1) pos += 1; // chunk padding
  }
  if (!fmt || dataOff < 0) {
    throw new Error(`[freeze-voice] missing fmt/data: ${filePath}`);
  }
  if (fmt.audioFormat !== 1) {
    throw new Error(
      `[freeze-voice] unsupported WAV audio format ${fmt.audioFormat} (PCM only): ${filePath}`,
    );
  }
  if (fmt.channels !== 1) {
    throw new Error(
      `[freeze-voice] only mono WAVs supported (got ${fmt.channels} channels): ${filePath}`,
    );
  }
  if (fmt.bitsPerSample !== 16) {
    throw new Error(
      `[freeze-voice] only 16-bit PCM supported (got ${fmt.bitsPerSample}): ${filePath}`,
    );
  }
  const n = dataLen / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(dataOff + i * 2);
    out[i] = s / 32768.0;
  }
  return { pcm: out, sampleRate: fmt.sampleRate };
}

/** Polyphase resampler — direct port of the OmniVoice-side
 *  `audio_resample` (linear interpolation between integer source samples
 *  with a windowed-sinc kernel). For freeze-time use, a simpler linear
 *  resampler is sufficient: the codec is invariant to small phase shifts
 *  on the reference, and the LM is conditioned on tokens, not raw PCM.
 *  If higher fidelity is needed, defer to ffmpeg in a pre-pass. */
function resampleLinear(pcm, srIn, srOut) {
  if (srIn === srOut) return pcm;
  const ratio = srOut / srIn;
  const nOut = Math.floor(pcm.length * ratio);
  const out = new Float32Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Discover the audio/transcript pairs in the corpus. Reads
 *  `manifest.jsonl` when present (preferred — gives durations + the
 *  `excluded` flag); otherwise glob `audio/*.wav` and pair with
 *  `audio/<id>.txt` transcripts.
 *
 *  Returns the list sorted by id, with excluded entries dropped.
 */
function discoverClips(args) {
  // Preferred: manifest.jsonl at corpus root.
  if (args.corpus && existsSync(path.join(args.corpus, "manifest.jsonl"))) {
    const lines = readFileSync(path.join(args.corpus, "manifest.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const recs = lines
      .map((l) => JSON.parse(l))
      .filter((r) => r && r.excluded !== true);
    recs.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return recs.map((r) => ({
      id: r.id,
      audioPath: path.join(args.corpus, r.audio_path),
      transcript: r.transcript ?? "",
      duration: r.duration_s ?? null,
    }));
  }
  // Fallback: scan audio dir.
  const audioRoot =
    args.audioDir ?? (args.corpus ? path.join(args.corpus, "audio") : null);
  if (!audioRoot || !existsSync(audioRoot)) {
    throw new Error(
      `[freeze-voice] no manifest.jsonl in --corpus and audio dir not found: ${audioRoot}`,
    );
  }
  const wavs = readdirSync(audioRoot)
    .filter((f) => f.toLowerCase().endsWith(".wav"))
    .sort();
  return wavs.map((f) => {
    const id = f.replace(/\.wav$/i, "");
    const txtPath = path.join(audioRoot, `${id}.txt`);
    const transcript = existsSync(txtPath)
      ? readFileSync(txtPath, "utf8").trim()
      : "";
    return {
      id,
      audioPath: path.join(audioRoot, f),
      transcript,
      duration: null,
    };
  });
}

/** Pick clips totalling up to `maxSeconds` of reference audio. Skips
 *  obviously bad transcripts (the s002='641.' Whisper-base hallucination
 *  surfaced in R12 §4 is `excluded:true` in the manifest, so already
 *  dropped above; but if a fallback scan misses it, skip ultra-short
 *  clips with implausibly-short transcripts). */
function selectReferenceClips(clips, maxSeconds, sampleRateHint) {
  const out = [];
  let total = 0;
  for (const c of clips) {
    // Refuse hallucinations: <3 chars of transcript on a <2 s clip is
    // almost always Whisper noise.
    if (
      c.duration !== null &&
      c.duration < 2.0 &&
      c.transcript.replace(/\s/g, "").length < 4
    ) {
      continue;
    }
    const dur =
      c.duration !== null
        ? c.duration
        : estimateDurationFromFile(c.audioPath, sampleRateHint);
    if (total + dur > maxSeconds && out.length > 0) break;
    out.push({ ...c, duration: dur });
    total += dur;
    if (total >= maxSeconds) break;
  }
  if (out.length === 0) {
    throw new Error(`[freeze-voice] no usable clips found`);
  }
  return { clips: out, totalSeconds: total };
}

function estimateDurationFromFile(filePath, sampleRateHint) {
  const sz = statSync(filePath).size;
  // 44-byte RIFF header + 2 bytes/sample for mono 16-bit.
  return (sz - 44) / 2 / (sampleRateHint || 44100);
}

/** Concatenate reference WAVs into one 24 kHz mono fp32 buffer. */
function loadAndConcat24k(clips) {
  const chunks = [];
  let totalLen = 0;
  for (const c of clips) {
    const wav = readWavMonoFloat(c.audioPath);
    const at24 = resampleLinear(wav.pcm, wav.sampleRate, 24000);
    chunks.push(at24);
    totalLen += at24.length;
  }
  const out = new Float32Array(totalLen);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.length;
  }
  return out;
}

/** Lazy-load the FFI binding only when we need to encode — keeps
 *  `--skip-encode` and `--dry-run` paths free of native deps. */
async function maybeEncodeReference(pcm24k, args) {
  if (args.skipEncode) {
    return { K: 0, refT: 0, tokens: new Int32Array(0) };
  }
  if (!args.dylib) {
    throw new Error(
      "[freeze-voice] --dylib is required to encode without --skip-encode " +
        "(loadElizaInferenceFfi takes a dylib path). " +
        "Typical path: <bundle>/lib/libelizainference.so (or .dylib on macOS).",
    );
  }
  const mod = await import(
    "../../../../plugins/plugin-local-inference/src/services/voice/ffi-bindings.ts"
  );
  const ffi = mod.loadElizaInferenceFfi(args.dylib);
  if (
    typeof ffi.encodeReferenceSupported !== "function" ||
    !ffi.encodeReferenceSupported()
  ) {
    throw new Error(
      "[freeze-voice] libelizainference does not export encodeReference (ABI < v4 or stub build). " +
        "Re-run with --skip-encode to write a metadata-only preset, or rebuild the fused library.",
    );
  }
  const ctx = ffi.create(args.bundle);
  try {
    ffi.mmapAcquire(ctx, "tts");
    const { K, refT, tokens } = ffi.encodeReference({
      ctx,
      pcm: pcm24k,
      sampleRateHz: 24000,
    });
    return { K, refT, tokens };
  } finally {
    try {
      ffi.mmapEvict(ctx, "tts");
    } catch {
      // best-effort eviction; falls through to destroy
    }
    ffi.destroy(ctx);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[freeze-voice] voice=${args.voice}`);
  console.log(`[freeze-voice] corpus=${args.corpus ?? "(audio-dir only)"}`);
  console.log(
    `[freeze-voice] audio-dir=${args.audioDir ?? "(default audio/)"}`,
  );
  console.log(`[freeze-voice] out=${args.out}`);
  console.log(`[freeze-voice] instruct=${JSON.stringify(args.instruct)}`);
  console.log(`[freeze-voice] max-seconds=${args.maxSeconds}`);
  console.log(`[freeze-voice] skip-encode=${args.skipEncode}`);
  console.log(`[freeze-voice] dry-run=${args.dryRun}`);

  const allClips = discoverClips(args);
  const { clips, totalSeconds } = selectReferenceClips(
    allClips,
    args.maxSeconds,
    44100,
  );
  console.log(
    `[freeze-voice] selected ${clips.length} clip(s), ~${totalSeconds.toFixed(2)} s total`,
  );
  for (const c of clips) {
    console.log(
      `  • ${c.id} (${c.duration?.toFixed?.(2) ?? "?"} s): ${c.transcript.slice(0, 60)}${
        c.transcript.length > 60 ? "…" : ""
      }`,
    );
  }

  if (args.dryRun) {
    console.log(`[freeze-voice] dry-run: skipping load + encode + write`);
    return;
  }

  const refText = clips
    .map((c) => c.transcript)
    .join(" ")
    .trim();
  const pcm24k = loadAndConcat24k(clips);
  console.log(
    `[freeze-voice] concatenated PCM: ${pcm24k.length} samples @ 24 kHz (${(pcm24k.length / 24000).toFixed(2)} s)`,
  );

  const { K, refT, tokens } = await maybeEncodeReference(pcm24k, args);
  console.log(
    `[freeze-voice] encoded: K=${K}, ref_T=${refT}, ${tokens.length} tokens`,
  );

  const metadata = {
    voiceId: args.voice,
    generator: "freeze-voice.mjs",
    generatedAt: new Date().toISOString(),
    referenceClipIds: clips.map((c) => c.id),
    referenceSeconds: Number(totalSeconds.toFixed(3)),
    sampleRateOut: 24000,
    corpus: args.corpus ?? args.audioDir,
    instruct: args.instruct,
  };

  const bytes = writeVoicePresetFileV2({
    refAudioTokens: { K, refT, tokens },
    refText,
    instruct: args.instruct,
    metadata,
  });

  // Roundtrip-validate before writing.
  const parsed = readVoicePresetFile(bytes);
  if (
    parsed.refAudioTokens.K !== K ||
    parsed.refAudioTokens.refT !== refT ||
    parsed.refAudioTokens.tokens.length !== tokens.length ||
    parsed.refText !== refText ||
    parsed.instruct !== args.instruct
  ) {
    throw new Error(`[freeze-voice] roundtrip validation failed`);
  }
  for (let i = 0; i < tokens.length; i++) {
    if (parsed.refAudioTokens.tokens[i] !== tokens[i]) {
      throw new Error(
        `[freeze-voice] roundtrip token mismatch at index ${i}: ${parsed.refAudioTokens.tokens[i]} != ${tokens[i]}`,
      );
    }
  }

  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, bytes);
  console.log(`[freeze-voice] wrote ${bytes.length} bytes to ${args.out}`);
}

main().catch((err) => {
  console.error(`[freeze-voice] ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
