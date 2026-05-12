#!/usr/bin/env bun
/**
 * Real local voice E2E harness runner.
 *
 * Model-backed cases use the fused Eliza-1 `libelizainference` ABI and
 * fail before running if required bundle artifacts are absent. Trace-only
 * cases (`latency`, `pause-continuation`, `rollback`) require either a
 * running dev latency endpoint or an explicit events JSON file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRequiredVoiceArtifacts,
  type BargeInInterruptionInput,
  type FirstResponseLatencyInput,
  type OptimisticRollbackRestartInput,
  type PauseContinuationInput,
  type RequiredVoiceArtifact,
  scoreBargeInInterruption,
  scoreFirstResponseLatency,
  scoreOptimisticRollbackRestart,
  scorePauseContinuation,
  scoreTtsAsrRoundTrip,
  summarizeVoiceE2e,
  type VoiceE2eCaseResult,
  VoiceE2eHarnessError,
} from "../src/services/local-inference/voice/e2e-harness";
import {
  type ElizaInferenceContextHandle,
  type ElizaInferenceFfi,
  loadElizaInferenceFfi,
} from "../src/services/local-inference/voice/ffi-bindings";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_PHRASE = "Eliza local voice end to end check.";
const GGUF_MIN_BYTES = 1024 * 1024;

type CaseName =
  | "roundtrip"
  | "barge-in"
  | "latency"
  | "pause-continuation"
  | "rollback";

interface CliArgs {
  bundle: string;
  dylib: string;
  backend: string;
  cases: CaseName[];
  phrase: string;
  out: string;
  audioDir: string;
  maxWer: number;
  maxBargeMs: number;
  maxFirstAudioMs: number;
  eventsJson: string;
  latencyBase: string;
  allowTtsOnlyBargeIn: boolean;
  json: boolean;
}

interface ResolvedBundleArtifacts {
  bundleRoot: string;
  dylib: string;
  ttsModel: string;
  ttsTokenizer: string;
  asrModel: string;
  asrMmproj: string;
  speakerPreset: string;
}

interface EventsJson {
  bargeInInterruption?: BargeInInterruptionInput;
  pauseContinuation?: PauseContinuationInput;
  optimisticRollbackRestart?: OptimisticRollbackRestartInput;
  firstResponseLatency?: FirstResponseLatencyInput;
}

interface PcmResult {
  pcm: Float32Array;
  sampleRate: number;
  ttsStartAtMs: number;
  firstAudioAtMs: number;
  doneAtMs: number;
  chunkCount: number;
  streamSupported: boolean;
}

function usage(): void {
  console.log(`Usage:
  bun packages/app-core/scripts/voice-e2e-hardware.ts --cases roundtrip --bundle <eliza-1.bundle> --dylib <libelizainference>

Cases:
  roundtrip            Real TTS -> real ASR WER check through libelizainference.
  barge-in             Scores barge-in from --events-json, or real native TTS cancel only with --allow-tts-only-barge-in.
  latency              Scores first response latency from --latency-base or --events-json.
  pause-continuation   Scores user pause/continuation from --events-json.
  rollback             Scores optimistic rollback/restart from --events-json.
  all                  Expands to every case above.

Options:
  --bundle <dir>       Bundle root. Defaults to ELIZA_VOICE_E2E_BUNDLE or first ~/.eliza/local-inference/models/*.bundle.
  --dylib <file>       libelizainference path. Defaults to ELIZA_VOICE_E2E_DYLIB or managed fused build.
  --backend <name>     Managed build backend for discovery. Default: metal on macOS, cpu elsewhere.
  --cases <list>       Comma-separated case list. Default: roundtrip.
  --phrase <text>      Roundtrip phrase. Default: "${DEFAULT_PHRASE}"
  --out <file>         Report JSON output. Default: packages/inference/reports/local-e2e/<date>/voice-e2e-<timestamp>.json
  --audio-dir <dir>    Directory for generated WAV samples.
  --max-wer <n>        WER threshold for roundtrip. Default: 0.15
  --events-json <file> Manual event timestamps for trace-only cases.
  --latency-base <url> Running API base URL for /api/dev/voice-latency.
  --allow-tts-only-barge-in
                       Permit barge-in case to measure only real native TTS cancel. Without this, barge-in requires --events-json.
  --json               Print JSON only.
`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    bundle: process.env.ELIZA_VOICE_E2E_BUNDLE || "",
    dylib: process.env.ELIZA_VOICE_E2E_DYLIB || "",
    backend: process.env.ELIZA_VOICE_E2E_BACKEND || defaultBackend(),
    cases: parseCases(process.env.ELIZA_VOICE_E2E_CASES || "roundtrip"),
    phrase: process.env.ELIZA_VOICE_E2E_PHRASE || DEFAULT_PHRASE,
    out: process.env.ELIZA_VOICE_E2E_REPORT || "",
    audioDir: process.env.ELIZA_VOICE_E2E_AUDIO_DIR || "",
    maxWer: Number(process.env.ELIZA_VOICE_E2E_MAX_WER || "0.15"),
    maxBargeMs: Number(process.env.ELIZA_VOICE_E2E_MAX_BARGE_MS || "250"),
    maxFirstAudioMs: Number(
      process.env.ELIZA_VOICE_E2E_MAX_FIRST_AUDIO_MS || "1500",
    ),
    eventsJson: process.env.ELIZA_VOICE_E2E_EVENTS_JSON || "",
    latencyBase: process.env.ELIZA_VOICE_E2E_LATENCY_BASE || "",
    allowTtsOnlyBargeIn:
      process.env.ELIZA_VOICE_E2E_ALLOW_TTS_ONLY_BARGE_IN === "1",
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      i++;
      const value = argv[i];
      if (!value) throw new Error(`${a} requires a value`);
      return value;
    };
    if (a === "--bundle" || a === "--bundle-dir") args.bundle = next();
    else if (a === "--dylib" || a === "--lib") args.dylib = next();
    else if (a === "--backend") args.backend = next();
    else if (a === "--cases" || a === "--case") args.cases = parseCases(next());
    else if (a === "--phrase") args.phrase = next();
    else if (a === "--out" || a === "--report") args.out = next();
    else if (a === "--audio-dir") args.audioDir = next();
    else if (a === "--max-wer") args.maxWer = Number(next());
    else if (a === "--max-barge-ms") args.maxBargeMs = Number(next());
    else if (a === "--max-first-audio-ms")
      args.maxFirstAudioMs = Number(next());
    else if (a === "--events-json") args.eventsJson = next();
    else if (a === "--latency-base") args.latencyBase = next();
    else if (a === "--allow-tts-only-barge-in") args.allowTtsOnlyBargeIn = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }

  return args;
}

function parseCases(value: string): CaseName[] {
  const raw = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const expanded = raw.includes("all")
    ? ["roundtrip", "barge-in", "latency", "pause-continuation", "rollback"]
    : raw;
  const allowed = new Set<CaseName>([
    "roundtrip",
    "barge-in",
    "latency",
    "pause-continuation",
    "rollback",
  ]);
  const out: CaseName[] = [];
  for (const item of expanded) {
    if (!allowed.has(item as CaseName)) {
      throw new Error(`unknown case "${item}"`);
    }
    const c = item as CaseName;
    if (!out.includes(c)) out.push(c);
  }
  return out.length > 0 ? out : ["roundtrip"];
}

function defaultBackend(): string {
  return process.platform === "darwin" ? "metal" : "cpu";
}

function stateRoot(): string {
  return (
    process.env.ELIZA_STATE_DIR?.trim() || path.join(os.homedir(), ".eliza")
  );
}

function timestamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function defaultReportPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(
    REPO_ROOT,
    "packages",
    "inference",
    "reports",
    "local-e2e",
    day,
    `voice-e2e-${timestamp()}.json`,
  );
}

function platformTag(): string {
  const sys =
    { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform] ||
    process.platform;
  const arch = { x64: "x64", arm64: "arm64" }[process.arch] || process.arch;
  return `${sys}-${arch}`;
}

function libName(): string {
  if (process.platform === "darwin") return "libelizainference.dylib";
  if (process.platform === "win32") return "libelizainference.dll";
  return "libelizainference.so";
}

function resolveBundle(explicit: string): string {
  if (explicit) return path.resolve(explicit);
  const modelsRoot = path.join(stateRoot(), "local-inference", "models");
  if (!fs.existsSync(modelsRoot)) {
    throw new VoiceE2eHarnessError(
      "missing-artifact",
      `No bundle supplied and ${modelsRoot} does not exist. Pass --bundle <eliza-1.bundle>.`,
    );
  }
  const bundles = fs
    .readdirSync(modelsRoot)
    .filter((entry) => entry.startsWith("eliza-1") && entry.endsWith(".bundle"))
    .map((entry) => path.join(modelsRoot, entry))
    .filter((entry) => fs.statSync(entry).isDirectory())
    .sort();
  if (bundles.length === 0) {
    throw new VoiceE2eHarnessError(
      "missing-artifact",
      `No Eliza-1 bundle found under ${modelsRoot}. Pass --bundle <eliza-1.bundle>.`,
    );
  }
  return bundles[0] as string;
}

function resolveDylib(
  explicit: string,
  bundleRoot: string,
  backend: string,
): string {
  if (explicit) return path.resolve(explicit);
  const bundled = path.join(bundleRoot, "lib", libName());
  if (fs.existsSync(bundled)) return bundled;

  const root = path.join(stateRoot(), "local-inference", "bin", "dflash");
  const preferred = path.join(
    root,
    `${platformTag()}-${backend}-fused`,
    libName(),
  );
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(root)) {
    const found = fs
      .readdirSync(root)
      .filter(
        (entry) => entry.startsWith(platformTag()) && entry.includes("-fused"),
      )
      .map((entry) => path.join(root, entry, libName()))
      .find((entry) => fs.existsSync(entry));
    if (found) return found;
  }
  return preferred;
}

function findGguf(dir: string, predicate: (file: string) => boolean): string {
  if (!fs.existsSync(dir)) return path.join(dir, "__missing__.gguf");
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".gguf"))
    .sort();
  const match = files.find(predicate);
  return match ? path.join(dir, match) : path.join(dir, "__missing__.gguf");
}

function resolveArtifacts(args: CliArgs): ResolvedBundleArtifacts {
  const bundleRoot = resolveBundle(args.bundle);
  const dylib = resolveDylib(args.dylib, bundleRoot, args.backend);
  const ttsDir = path.join(bundleRoot, "tts");
  const asrDir = path.join(bundleRoot, "asr");
  return {
    bundleRoot,
    dylib,
    ttsModel: findGguf(ttsDir, (file) => !/(token|codec|dac)/i.test(file)),
    ttsTokenizer: findGguf(ttsDir, (file) => /(token|codec|dac)/i.test(file)),
    asrModel: findGguf(asrDir, (file) => !/mmproj|proj/i.test(file)),
    asrMmproj: findGguf(asrDir, (file) => /mmproj|proj/i.test(file)),
    speakerPreset: path.join(bundleRoot, "cache", "voice-preset-default.bin"),
  };
}

function artifactRequirements(
  artifacts: ResolvedBundleArtifacts,
): RequiredVoiceArtifact[] {
  return [
    { kind: "bundle-root", path: artifacts.bundleRoot },
    { kind: "ffi-library", path: artifacts.dylib, minBytes: 1024 },
    {
      kind: "speaker-preset",
      path: artifacts.speakerPreset,
      minBytes: 1,
    },
    {
      kind: "tts-model",
      path: artifacts.ttsModel,
      minBytes: GGUF_MIN_BYTES,
      magic: "GGUF",
    },
    {
      kind: "tts-tokenizer",
      path: artifacts.ttsTokenizer,
      minBytes: GGUF_MIN_BYTES,
      magic: "GGUF",
    },
    {
      kind: "asr-model",
      path: artifacts.asrModel,
      minBytes: GGUF_MIN_BYTES,
      magic: "GGUF",
    },
    {
      kind: "asr-mmproj",
      path: artifacts.asrMmproj,
      minBytes: GGUF_MIN_BYTES,
      magic: "GGUF",
    },
  ];
}

function fsProbe() {
  return {
    exists: (p: string) => fs.existsSync(p),
    size: (p: string) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return null;
      }
    },
    readMagic: (p: string, bytes: number) => {
      try {
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(bytes);
        fs.readSync(fd, buf, 0, bytes, 0);
        fs.closeSync(fd);
        return buf.toString("utf8");
      } catch {
        return null;
      }
    },
  };
}

function writeWav16(file: string, pcm: Float32Array, sampleRate: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

function mergePcm(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function synthesize(
  ffi: ElizaInferenceFfi,
  ctx: ElizaInferenceContextHandle,
  text: string,
): PcmResult {
  const streamSupported = ffi.ttsStreamSupported();
  const ttsStartAtMs = performance.now();
  const chunks: Float32Array[] = [];
  let firstAudioAtMs: number | null = null;
  let chunkCount = 0;

  if (streamSupported) {
    ffi.ttsSynthesizeStream({
      ctx,
      text,
      speakerPresetId: null,
      onChunk: ({ pcm, isFinal }) => {
        if (!isFinal && pcm.length > 0) {
          chunkCount++;
          if (firstAudioAtMs === null) firstAudioAtMs = performance.now();
          chunks.push(new Float32Array(pcm));
        }
        return false;
      },
    });
  } else {
    const out = new Float32Array(24_000 * 12);
    const samples = ffi.ttsSynthesize({
      ctx,
      text,
      speakerPresetId: null,
      out,
    });
    firstAudioAtMs = performance.now();
    chunkCount = samples > 0 ? 1 : 0;
    chunks.push(new Float32Array(out.subarray(0, samples)));
  }

  const doneAtMs = performance.now();
  if (firstAudioAtMs === null) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      "TTS completed without emitting any PCM samples",
    );
  }
  return {
    pcm: mergePcm(chunks),
    sampleRate: 24_000,
    ttsStartAtMs,
    firstAudioAtMs,
    doneAtMs,
    chunkCount,
    streamSupported,
  };
}

function runRoundTrip(
  args: CliArgs,
  ffi: ElizaInferenceFfi,
  ctx: ElizaInferenceContextHandle,
) {
  const tts = synthesize(ffi, ctx, args.phrase);
  const asrStartedAtMs = performance.now();
  const transcript = ffi.asrTranscribe({
    ctx,
    pcm: tts.pcm,
    sampleRateHz: tts.sampleRate,
  });
  const asrDoneAtMs = performance.now();
  const score = scoreTtsAsrRoundTrip({
    referenceText: args.phrase,
    hypothesisText: transcript,
    maxWer: args.maxWer,
  });
  const firstTtsAudio = scoreFirstResponseLatency({
    turnStartedAtMs: tts.ttsStartAtMs,
    ttsFirstAudioAtMs: tts.firstAudioAtMs,
    maxFirstAudioMs: args.maxFirstAudioMs,
  });
  return {
    score,
    tts: {
      streamSupported: tts.streamSupported,
      chunkCount: tts.chunkCount,
      samples: tts.pcm.length,
      audioSec: round2(tts.pcm.length / tts.sampleRate),
      synthMs: round1(tts.doneAtMs - tts.ttsStartAtMs),
      firstAudioMs: firstTtsAudio.firstAudioMs,
    },
    asr: {
      transcript,
      latencyMs: round1(asrDoneAtMs - asrStartedAtMs),
    },
    pcm: tts.pcm,
    sampleRate: tts.sampleRate,
  };
}

function runNativeTtsBargeIn(
  args: CliArgs,
  ffi: ElizaInferenceFfi,
  ctx: ElizaInferenceContextHandle,
): VoiceE2eCaseResult {
  if (!ffi.ttsStreamSupported()) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      "barge-in requires streaming TTS for native cancel measurement; eliza_inference_tts_stream_supported() returned 0",
    );
  }

  const phrase =
    "This is a deliberately longer local speech response used to verify that native text to speech can be interrupted while audio chunks are streaming.";
  let voiceDetectedAtMs: number | null = null;
  let ttsCancelledAtMs: number | null = null;
  let cancelled = false;

  const result = ffi.ttsSynthesizeStream({
    ctx,
    text: phrase,
    speakerPresetId: null,
    onChunk: ({ pcm, isFinal }) => {
      if (!isFinal && pcm.length > 0 && voiceDetectedAtMs === null) {
        voiceDetectedAtMs = performance.now();
        ffi.cancelTts(ctx);
        return true;
      }
      return false;
    },
  });
  ttsCancelledAtMs = performance.now();
  cancelled = result.cancelled;
  if (!cancelled) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      "native TTS stream did not acknowledge cancellation after barge-in trigger",
    );
  }

  return scoreBargeInInterruption({
    voiceDetectedAtMs: requiredNumber(voiceDetectedAtMs, "voiceDetectedAtMs"),
    ttsCancelledAtMs,
    audioDrainedAtMs: ttsCancelledAtMs,
    maxCancelMs: args.maxBargeMs,
    requireLlmCancel: false,
  });
}

async function scoreLatencyFromEndpoint(
  baseUrl: string,
  maxFirstAudioMs: number,
) {
  const url = new URL("/api/dev/voice-latency", baseUrl.replace(/\/$/, ""));
  url.searchParams.set("limit", "1");
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      `voice latency endpoint returned HTTP ${res.status}: ${url.toString()}`,
    );
  }
  const payload = await res.json();
  const traces = Array.isArray(payload?.traces) ? payload.traces : [];
  const trace = traces[traces.length - 1];
  if (!trace) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      `voice latency endpoint has no traces: ${url.toString()}`,
    );
  }
  const checkpoints = new Map<string, number>();
  for (const cp of trace.checkpoints ?? []) {
    if (typeof cp?.name === "string" && Number.isFinite(cp?.tMs)) {
      checkpoints.set(cp.name, cp.tMs);
    }
  }
  return scoreFirstResponseLatency({
    turnStartedAtMs: 0,
    asrFinalAtMs: checkpoints.get("asr-final"),
    llmFirstTokenAtMs: checkpoints.get("llm-first-token"),
    ttsFirstAudioAtMs: checkpoints.get("tts-first-audio-chunk"),
    audioFirstPlayedAtMs: checkpoints.get("audio-first-played"),
    maxFirstAudioMs,
  });
}

function loadEvents(file: string): EventsJson {
  if (!file) return {};
  if (!fs.existsSync(file)) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      `events JSON not found: ${file}`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as EventsJson;
}

function requiredNumber(
  value: number | null | undefined,
  name: string,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new VoiceE2eHarnessError(
      "missing-measurement",
      `Missing required voice E2E measurement: ${name}`,
    );
  }
  return value;
}

function needsArtifacts(cases: readonly CaseName[], args: CliArgs): boolean {
  return (
    cases.includes("roundtrip") ||
    (cases.includes("barge-in") && args.allowTtsOnlyBargeIn)
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.out ? path.resolve(args.out) : defaultReportPath();
  const events = loadEvents(args.eventsJson);
  const cases: VoiceE2eCaseResult[] = [];
  let artifacts: ResolvedBundleArtifacts | null = null;
  let realSampleGenerated = false;
  let generatedWav: string | null = null;
  let roundTripDetails: unknown = null;

  if (needsArtifacts(args.cases, args)) {
    artifacts = resolveArtifacts(args);
    assertRequiredVoiceArtifacts(artifactRequirements(artifacts), fsProbe());
  }

  if (artifacts) {
    const libDir = path.dirname(artifacts.dylib);
    process.env.LD_LIBRARY_PATH = `${libDir}${path.delimiter}${
      process.env.LD_LIBRARY_PATH || ""
    }`;
    if (process.platform === "darwin") {
      process.env.DYLD_LIBRARY_PATH = `${libDir}${path.delimiter}${
        process.env.DYLD_LIBRARY_PATH || ""
      }`;
    }
  }

  let ffi: ElizaInferenceFfi | null = null;
  let ctx: ElizaInferenceContextHandle | null = null;
  try {
    if (artifacts) {
      ffi = loadElizaInferenceFfi(artifacts.dylib);
      ctx = ffi.create(artifacts.bundleRoot);
      ffi.mmapAcquire(ctx, "tts");
      ffi.mmapAcquire(ctx, "asr");
    }

    if (args.cases.includes("roundtrip")) {
      if (!ffi || ctx === null) throw new Error("unreachable: missing FFI");
      const roundTrip = runRoundTrip(args, ffi, ctx);
      cases.push(roundTrip.score);
      roundTripDetails = {
        tts: roundTrip.tts,
        asr: roundTrip.asr,
      };
      const audioDir =
        args.audioDir || path.join(path.dirname(reportPath), "audio");
      fs.mkdirSync(audioDir, { recursive: true });
      generatedWav = path.join(
        audioDir,
        `tts-asr-roundtrip-${timestamp()}.wav`,
      );
      writeWav16(generatedWav, roundTrip.pcm, roundTrip.sampleRate);
      realSampleGenerated = true;
    }

    if (args.cases.includes("barge-in")) {
      if (events.bargeInInterruption) {
        cases.push(
          scoreBargeInInterruption({
            ...events.bargeInInterruption,
            maxCancelMs: args.maxBargeMs,
          }),
        );
      } else if (args.allowTtsOnlyBargeIn) {
        if (!ffi || ctx === null) throw new Error("unreachable: missing FFI");
        cases.push(runNativeTtsBargeIn(args, ffi, ctx));
      } else {
        throw new VoiceE2eHarnessError(
          "missing-measurement",
          "barge-in case requires --events-json with bargeInInterruption timestamps, or --allow-tts-only-barge-in for the narrower native TTS cancel check",
        );
      }
    }

    if (args.cases.includes("latency")) {
      if (events.firstResponseLatency) {
        cases.push(
          scoreFirstResponseLatency({
            ...events.firstResponseLatency,
            maxFirstAudioMs: args.maxFirstAudioMs,
          }),
        );
      } else if (args.latencyBase) {
        cases.push(
          await scoreLatencyFromEndpoint(
            args.latencyBase,
            args.maxFirstAudioMs,
          ),
        );
      } else {
        throw new VoiceE2eHarnessError(
          "missing-measurement",
          "latency case requires --latency-base <api-url> or --events-json with firstResponseLatency timestamps",
        );
      }
    }

    if (args.cases.includes("pause-continuation")) {
      if (!events.pauseContinuation) {
        throw new VoiceE2eHarnessError(
          "missing-measurement",
          "pause-continuation case requires --events-json with pauseContinuation timestamps",
        );
      }
      cases.push(scorePauseContinuation(events.pauseContinuation));
    }

    if (args.cases.includes("rollback")) {
      if (!events.optimisticRollbackRestart) {
        throw new VoiceE2eHarnessError(
          "missing-measurement",
          "rollback case requires --events-json with optimisticRollbackRestart timestamps",
        );
      }
      cases.push(
        scoreOptimisticRollbackRestart(events.optimisticRollbackRestart),
      );
    }
  } finally {
    if (ffi && ctx !== null) {
      try {
        ffi.mmapEvict(ctx, "asr");
        ffi.mmapEvict(ctx, "tts");
      } catch {
        // The run is already over; destroy below is the hard cleanup path.
      }
      ffi.destroy(ctx);
      ffi.close();
    }
  }

  const summary = summarizeVoiceE2e(cases);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, __filename),
    requestedCases: args.cases,
    summary,
    artifacts,
    roundTripDetails,
    generatedSample: generatedWav,
    realSampleGenerated,
    inputs: {
      phrase: args.phrase,
      maxWer: args.maxWer,
      maxBargeMs: args.maxBargeMs,
      maxFirstAudioMs: args.maxFirstAudioMs,
      eventsJson: args.eventsJson || null,
      latencyBase: args.latencyBase || null,
      allowTtsOnlyBargeIn: args.allowTtsOnlyBargeIn,
    },
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`wrote ${reportPath}`);
    console.log(
      `voice-e2e: passed=${summary.passed} cases=${cases
        .map((c) => `${c.kind}:${c.passed ? "pass" : "fail"}`)
        .join(", ")}`,
    );
    if (generatedWav) console.log(`generated sample: ${generatedWav}`);
  }
  process.exit(summary.passed ? 0 : 1);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof VoiceE2eHarnessError) {
    console.error(`[voice-e2e] ${err.code}: ${message}`);
    process.exit(err.code === "missing-artifact" ? 2 : 3);
  }
  console.error(
    `[voice-e2e] fatal: ${err instanceof Error ? err.stack : message}`,
  );
  process.exit(1);
});
