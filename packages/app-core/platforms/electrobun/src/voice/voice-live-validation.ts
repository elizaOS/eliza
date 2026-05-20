import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { TraceService } from "../trace/trace-service";
import { TraceStore } from "../trace/trace-store";
import { VoiceError } from "./errors";
import type {
  VoiceComponentSnapshot,
  VoiceLatencySummary,
  VoicePlaybackEvent,
  VoiceRuntimeStatus,
  VoiceSynthesisResult,
  VoiceTurn,
} from "./types";
import {
  evaluateVoiceLatencyBudget,
  getVoiceLatencyBudgetFromEnv,
  type VoiceLatencyBudgetResult,
} from "./voice-latency-budget";
import { discoverStaticVoiceComponents } from "./voice-pipeline";
import {
  RuntimeHttpVoiceAdapter,
  type VoiceRuntimeAdapter,
} from "./voice-runtime-adapter";
import { VoiceService } from "./voice-service";

export type VoiceLiveValidationMode =
  | "dry-run"
  | "runtime"
  | "asr"
  | "tts"
  | "playback"
  | "full";

export type VoiceLiveValidationCheck = {
  name: string;
  ok: boolean;
  required: boolean;
  status?: string;
  error?: string;
  details?: JsonValue;
};

export type VoiceLiveValidationArtifact = {
  kind: "audio" | "json" | "log" | "trace";
  path?: string;
  description?: string;
};

export type VoiceLiveValidationReport = {
  mode: VoiceLiveValidationMode;
  startedAt: string;
  completedAt: string;
  checks: VoiceLiveValidationCheck[];
  components: VoiceComponentSnapshot[];
  latency?: VoiceLatencySummary;
  budgetResults?: VoiceLatencyBudgetResult[];
  traceSessionId?: string;
  artifacts?: VoiceLiveValidationArtifact[];
  recommendations: string[];
};

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

type VoiceLiveValidationOptions = {
  env?: Record<string, string | undefined>;
  adapter?: VoiceRuntimeAdapter;
  service?: VoiceService;
  fetchImpl?: FetchImpl;
  now?: () => Date;
  readFileImpl?: (path: string) => Promise<Buffer | Uint8Array>;
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
  mkdirImpl?: (
    path: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;
};

type TtsValidationResult = {
  result: VoiceSynthesisResult;
  artifact?: VoiceLiveValidationArtifact;
};

class ValidationCanvas {
  private count = 0;

  async createWindow(): Promise<{ id: string }> {
    this.count += 1;
    return { id: `voice-validation-view-${this.count}` };
  }

  async destroyWindow(): Promise<void> {}

  async a2uiPush(): Promise<void> {}
}

class ValidationWorkerStatusProvider {
  getWorkerStatus(): { state: string } {
    return { state: "running" };
  }
}

function isTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonDetails(value: JsonValue): JsonValue {
  return value;
}

function selectMode(
  env: Record<string, string | undefined>,
): VoiceLiveValidationMode {
  const runtime = isTruthy(env.ELIZA_VOICE_LIVE_RUNTIME);
  const audio = isTruthy(env.ELIZA_VOICE_LIVE_AUDIO);
  const asr = isTruthy(env.ELIZA_VOICE_LIVE_ASR);
  const tts = isTruthy(env.ELIZA_VOICE_LIVE_TTS);
  const playback = isTruthy(env.ELIZA_VOICE_LIVE_PLAYBACK);
  if (runtime && (audio || asr) && tts && playback) return "full";
  if (playback) return "playback";
  if (tts) return "tts";
  if (asr || audio) return "asr";
  if (runtime) return "runtime";
  return "dry-run";
}

function validationText(env: Record<string, string | undefined>): string {
  const text = env.ELIZA_VOICE_VALIDATION_TEXT?.trim();
  return text || "Eliza voice validation.";
}

function apiBase(env: Record<string, string | undefined>): string {
  return (
    env.ELIZA_RUNTIME_API_BASE ??
    env.MILADY_DESKTOP_API_BASE ??
    "http://127.0.0.1:31337"
  );
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function audioExtension(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("flac")) return "flac";
  return "bin";
}

function componentReady(
  components: VoiceComponentSnapshot[],
  id: string,
): VoiceComponentSnapshot | null {
  return (
    components.find(
      (component) => component.id === id && component.status === "ready",
    ) ?? null
  );
}

function selectTtsComponent(
  components: VoiceComponentSnapshot[],
): VoiceComponentSnapshot | null {
  return (
    componentReady(components, "kokoro") ??
    componentReady(components, "omnivoice")
  );
}

function toCheck(params: VoiceLiveValidationCheck): VoiceLiveValidationCheck {
  return params;
}

function budgetRecommendations(results: VoiceLatencyBudgetResult[]): string[] {
  const recommendations: string[] = [];
  const missing = results.filter((result) => result.actualMs === undefined);
  const missed = results.filter(
    (result) => result.actualMs !== undefined && !result.ok,
  );
  if (missing.length > 0) {
    recommendations.push(
      `Missing latency measurements: ${missing.map((result) => result.stage).join(", ")}`,
    );
  }
  for (const result of missed) {
    recommendations.push(
      `${result.stage} missed budget: ${result.actualMs}ms > ${result.budgetMs}ms`,
    );
  }
  return recommendations;
}

function checkRecommendations(checks: VoiceLiveValidationCheck[]): string[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => {
      const suffix = check.error ? `: ${check.error}` : "";
      return `${check.name} unavailable${suffix}`;
    });
}

function createTraceService(
  env: Record<string, string | undefined>,
  now?: () => Date,
): TraceService {
  const registry = new DynamicViewRegistry();
  const sessions = new DynamicViewSessionManager({
    registry,
    canvas: new ValidationCanvas(),
    workerStatusProvider: new ValidationWorkerStatusProvider(),
    now: now ?? (() => new Date()),
  });
  return new TraceService({
    store: new TraceStore({ now: now ?? (() => new Date()) }),
    dynamicViewRegistry: registry,
    dynamicViewSessions: sessions,
    env,
  });
}

async function probeRuntime(
  env: Record<string, string | undefined>,
  fetchImpl: FetchImpl,
): Promise<VoiceLiveValidationCheck> {
  const base = stripSlash(apiBase(env));
  const paths = ["/api/health", "/api/status", "/api/dev/stack"];
  const attempts: JsonValue[] = [];
  for (const path of paths) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3_000);
      const response = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      attempts.push({ path, status: response.status, ok: response.ok });
      if (response.ok) {
        return toCheck({
          name: "runtime.api",
          ok: true,
          required: true,
          status: `${response.status}`,
          details: { apiBase: base, path, attempts },
        });
      }
    } catch (error) {
      attempts.push({ path, ok: false, error: jsonError(error) });
    }
  }
  return toCheck({
    name: "runtime.api",
    ok: false,
    required: true,
    error: "No runtime health/status route responded successfully.",
    details: { apiBase: base, attempts },
  });
}

async function discoverComponents(params: {
  mode: VoiceLiveValidationMode;
  adapter: VoiceRuntimeAdapter;
}): Promise<{
  components: VoiceComponentSnapshot[];
  check: VoiceLiveValidationCheck;
}> {
  if (params.mode === "dry-run") {
    const components = discoverStaticVoiceComponents();
    return {
      components,
      check: {
        name: "voice.components",
        ok: true,
        required: false,
        status: "static",
        details: { count: components.length },
      },
    };
  }
  try {
    const components = await params.adapter.components();
    return {
      components,
      check: {
        name: "voice.components",
        ok: true,
        required: true,
        status: "runtime",
        details: { count: components.length },
      },
    };
  } catch (error) {
    return {
      components: discoverStaticVoiceComponents(),
      check: {
        name: "voice.components",
        ok: false,
        required: true,
        error: jsonError(error),
        details: { fallback: "static" },
      },
    };
  }
}

async function readAudioBase64(params: {
  path: string;
  readFileImpl: (path: string) => Promise<Buffer | Uint8Array>;
}): Promise<{ audioBase64: string; mimeType: string; byteLength: number }> {
  const bytes = await params.readFileImpl(params.path);
  return {
    audioBase64: Buffer.from(bytes).toString("base64"),
    mimeType: mimeTypeForPath(params.path),
    byteLength: bytes.byteLength,
  };
}

async function validateAsr(params: {
  env: Record<string, string | undefined>;
  adapter: VoiceRuntimeAdapter;
  mode: VoiceLiveValidationMode;
  checks: VoiceLiveValidationCheck[];
  readFileImpl: (path: string) => Promise<Buffer | Uint8Array>;
}): Promise<string | null> {
  if (
    !isTruthy(params.env.ELIZA_VOICE_LIVE_ASR) &&
    !isTruthy(params.env.ELIZA_VOICE_LIVE_AUDIO)
  ) {
    params.checks.push({
      name: "asr.route",
      ok: true,
      required: false,
      status: "skipped",
    });
    return null;
  }
  const audioPath = params.env.ELIZA_VOICE_VALIDATION_AUDIO_PATH;
  if (!audioPath) {
    params.checks.push({
      name: "asr.route",
      ok: false,
      required: params.mode === "full",
      error:
        "ELIZA_VOICE_VALIDATION_AUDIO_PATH is required for live ASR validation.",
    });
    return null;
  }
  if (!params.adapter.transcribeAudio) {
    params.checks.push({
      name: "asr.route",
      ok: false,
      required: true,
      error: "Active adapter does not expose ASR transcription.",
    });
    return null;
  }
  try {
    const audio = await readAudioBase64({
      path: audioPath,
      readFileImpl: params.readFileImpl,
    });
    const startedAt = Date.now();
    const result = await params.adapter.transcribeAudio({
      audioBase64: audio.audioBase64,
      mimeType: audio.mimeType,
      metadata: { sourcePath: audioPath },
    });
    params.checks.push({
      name: "asr.route",
      ok: true,
      required: true,
      status: "final",
      details: {
        transcript: result.text,
        audioPath,
        byteLength: audio.byteLength,
        durationMs: Date.now() - startedAt,
      },
    });
    return result.text;
  } catch (error) {
    params.checks.push({
      name: "asr.route",
      ok: false,
      required: true,
      error: jsonError(error),
    });
    return null;
  }
}

async function validateTts(params: {
  env: Record<string, string | undefined>;
  adapter: VoiceRuntimeAdapter;
  components: VoiceComponentSnapshot[];
  checks: VoiceLiveValidationCheck[];
  writeFileImpl: (path: string, data: Buffer) => Promise<void>;
  mkdirImpl: (
    path: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;
  startedAt: string;
}): Promise<TtsValidationResult | null> {
  if (!isTruthy(params.env.ELIZA_VOICE_LIVE_TTS)) {
    params.checks.push({
      name: "tts.route",
      ok: true,
      required: false,
      status: "skipped",
    });
    return null;
  }
  const component = selectTtsComponent(params.components);
  if (!component) {
    params.checks.push({
      name: "tts.route",
      ok: false,
      required: true,
      error: "No ready Kokoro or OmniVoice component was reported by runtime.",
    });
    return null;
  }
  if (!params.adapter.synthesizeSpeech) {
    params.checks.push({
      name: "tts.route",
      ok: false,
      required: true,
      error: "Active adapter does not expose speech synthesis.",
    });
    return null;
  }
  const text = validationText(params.env);
  const startedAt = Date.now();
  try {
    const result = await params.adapter.synthesizeSpeech({
      text,
      voiceId: component.id,
      metadata: { validation: true },
    });
    let artifact: VoiceLiveValidationArtifact | undefined;
    const outputDir = params.env.ELIZA_VOICE_VALIDATION_OUTPUT_DIR;
    if (outputDir) {
      await params.mkdirImpl(outputDir, { recursive: true });
      const safeStamp = params.startedAt.replace(/[:.]/g, "-");
      const filename = `eliza-voice-validation-${safeStamp}.${audioExtension(result.mimeType)}`;
      const path = join(outputDir, filename);
      await params.writeFileImpl(
        path,
        Buffer.from(result.audioBase64, "base64"),
      );
      artifact = {
        kind: "audio",
        path,
        description: `Synthesized ${basename(path)}`,
      };
    }
    params.checks.push({
      name: "tts.route",
      ok: true,
      required: true,
      status: component.id,
      details: {
        provider: result.provider ?? component.provider ?? component.id,
        voiceId: result.voiceId ?? component.id,
        byteLength: result.byteLength,
        mimeType: result.mimeType,
        firstAudioMs: Date.now() - startedAt,
      },
    });
    return { result, artifact };
  } catch (error) {
    params.checks.push({
      name: "tts.route",
      ok: false,
      required: true,
      error: jsonError(error),
    });
    return null;
  }
}

async function validatePlayback(params: {
  env: Record<string, string | undefined>;
  adapter: VoiceRuntimeAdapter;
  ttsResult: TtsValidationResult | null;
  checks: VoiceLiveValidationCheck[];
  readFileImpl: (path: string) => Promise<Buffer | Uint8Array>;
}): Promise<VoicePlaybackEvent | null> {
  if (!isTruthy(params.env.ELIZA_VOICE_LIVE_PLAYBACK)) {
    params.checks.push({
      name: "playback.ack",
      ok: true,
      required: false,
      status: "skipped",
    });
    return null;
  }
  if (!params.adapter.playAudio) {
    params.checks.push({
      name: "playback.ack",
      ok: false,
      required: true,
      error: "Active adapter does not expose playback.",
      details: { playbackAckSupported: false },
    });
    return null;
  }
  const audioPath = params.env.ELIZA_VOICE_VALIDATION_AUDIO_PATH;
  try {
    const audio = params.ttsResult
      ? {
          audioBase64: params.ttsResult.result.audioBase64,
          mimeType: params.ttsResult.result.mimeType,
        }
      : audioPath
        ? await readAudioBase64({
            path: audioPath,
            readFileImpl: params.readFileImpl,
          })
        : null;
    if (!audio) {
      params.checks.push({
        name: "playback.ack",
        ok: false,
        required: true,
        error:
          "Playback validation requires synthesized audio or ELIZA_VOICE_VALIDATION_AUDIO_PATH.",
      });
      return null;
    }
    const result = await params.adapter.playAudio({
      audioBase64: audio.audioBase64,
      mimeType: audio.mimeType,
      metadata: { validation: true },
    });
    params.checks.push({
      name: "playback.ack",
      ok: result.started,
      required: true,
      status: result.started ? "started" : "not-started",
      details: { playbackAckSupported: result.started },
    });
    return result;
  } catch (error) {
    params.checks.push({
      name: "playback.ack",
      ok: false,
      required: true,
      error: jsonError(error),
      details: { playbackAckSupported: false },
    });
    return null;
  }
}

async function validateFullPath(params: {
  env: Record<string, string | undefined>;
  service: VoiceService;
  transcript: string | null;
  checks: VoiceLiveValidationCheck[];
}): Promise<{ turn: VoiceTurn | null; traceSessionId?: string }> {
  if (selectMode(params.env) !== "full") {
    params.checks.push({
      name: "full.turn",
      ok: true,
      required: false,
      status: "skipped",
    });
    return { turn: null };
  }
  const text = params.transcript ?? validationText(params.env);
  try {
    await params.service.start({ mode: "local-runtime", trace: true });
    const turn = await params.service.injectTranscript({
      text,
      final: true,
      trace: true,
    });
    params.checks.push({
      name: "full.turn",
      ok: true,
      required: true,
      status: turn.status,
      details: {
        traceSessionId: turn.traceSessionId ?? null,
        transcriptFinal: turn.transcriptFinal ?? null,
        responseText: turn.responseText ?? null,
      },
    });
    return { turn, traceSessionId: turn.traceSessionId };
  } catch (error) {
    params.checks.push({
      name: "full.turn",
      ok: false,
      required: true,
      error: jsonError(error),
    });
    return { turn: null };
  }
}

function createValidationChecks(
  env: Record<string, string | undefined>,
  mode: VoiceLiveValidationMode,
): VoiceLiveValidationCheck[] {
  return [
    {
      name: "validation.mode",
      ok: true,
      required: true,
      status: mode,
      details: {
        apiBase: apiBase(env),
        allowModelActivation: isTruthy(env.ELIZA_VOICE_ALLOW_MODEL_ACTIVATION),
        streamAsrPartials: isTruthy(env.ELIZA_VOICE_STREAM_ASR_PARTIALS),
      },
    },
    {
      name: "model.activation",
      ok: true,
      required: false,
      status: isTruthy(env.ELIZA_VOICE_ALLOW_MODEL_ACTIVATION)
        ? "allowed"
        : "disabled",
    },
  ];
}

async function validateRuntimeStatus(params: {
  adapter: VoiceRuntimeAdapter;
  checks: VoiceLiveValidationCheck[];
  mode: VoiceLiveValidationMode;
}): Promise<VoiceRuntimeStatus | null> {
  try {
    const runtimeStatus = await params.adapter.status();
    params.checks.push({
      name: "runtime.status",
      ok: true,
      required: params.mode !== "dry-run",
      status: runtimeStatus.mode,
      details: {
        listening: runtimeStatus.listening,
        asrPartialSupport: runtimeStatus.asrPartialSupport,
        ttsStreamingSupport: runtimeStatus.ttsStreamingSupport,
        playbackSupport: runtimeStatus.playbackSupport,
        playbackAckSupport: runtimeStatus.playbackAckSupport,
        runtimeDraftSupport: runtimeStatus.runtimeDraftSupport === true,
      },
    });
    return runtimeStatus;
  } catch (error) {
    params.checks.push({
      name: "runtime.status",
      ok: false,
      required: params.mode !== "dry-run",
      error: jsonError(error),
    });
    return null;
  }
}

function collectValidationArtifacts(params: {
  ttsResult: Awaited<ReturnType<typeof validateTts>>;
  traceSessionId?: string;
}): VoiceLiveValidationReport["artifacts"] {
  const artifacts = [
    ...(params.ttsResult?.artifact ? [params.ttsResult.artifact] : []),
    ...(params.traceSessionId
      ? [
          {
            kind: "trace" as const,
            description: `Trace session ${params.traceSessionId}`,
          },
        ]
      : []),
  ];
  return artifacts.length > 0 ? artifacts : undefined;
}

function collectValidationRecommendations(params: {
  checks: VoiceLiveValidationCheck[];
  budgetResults: VoiceLatencyBudgetResult[];
  runtimeStatus: VoiceRuntimeStatus | null;
  env: Record<string, string | undefined>;
}): string[] {
  const recommendations = [
    ...checkRecommendations(params.checks),
    ...budgetRecommendations(params.budgetResults),
    ...(params.runtimeStatus?.playbackAckSupport === false &&
    isTruthy(params.env.ELIZA_VOICE_LIVE_PLAYBACK)
      ? [
          "Wire host playback acknowledgement before marking live playback started.",
        ]
      : []),
  ];
  return Array.from(new Set(recommendations));
}

export async function runVoiceLiveValidation(
  options: VoiceLiveValidationOptions = {},
): Promise<VoiceLiveValidationReport> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const mode = selectMode(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const adapter =
    options.adapter ??
    new RuntimeHttpVoiceAdapter({
      env,
      apiBase: apiBase(env),
    });
  const service =
    options.service ??
    new VoiceService({
      env,
      runtimeAdapter: adapter,
      traceService: createTraceService(env, now),
      now,
    });
  const checks = createValidationChecks(env, mode);
  const runtimeStatus = await validateRuntimeStatus({ adapter, checks, mode });
  if (mode !== "dry-run") {
    checks.push(await probeRuntime(env, fetchImpl));
  }
  const discovered = await discoverComponents({ mode, adapter });
  checks.push(discovered.check);
  const transcript = await validateAsr({
    env,
    adapter,
    mode,
    checks,
    readFileImpl: options.readFileImpl ?? readFile,
  });
  const ttsResult = await validateTts({
    env,
    adapter,
    components: discovered.components,
    checks,
    writeFileImpl: options.writeFileImpl ?? writeFile,
    mkdirImpl: options.mkdirImpl ?? mkdir,
    startedAt,
  });
  await validatePlayback({
    env,
    adapter,
    ttsResult,
    checks,
    readFileImpl: options.readFileImpl ?? readFile,
  });
  const full = await validateFullPath({
    env,
    service,
    transcript,
    checks,
  });
  const latency = await service.latency();
  const budgetResults =
    latency.budgetResults ??
    evaluateVoiceLatencyBudget(latency, getVoiceLatencyBudgetFromEnv(env));
  return {
    mode,
    startedAt,
    completedAt: now().toISOString(),
    checks,
    components: discovered.components,
    latency: Object.keys(latency).length > 0 ? latency : undefined,
    budgetResults,
    traceSessionId: full.traceSessionId,
    artifacts: collectValidationArtifacts({
      ttsResult,
      traceSessionId: full.traceSessionId,
    }),
    recommendations: collectValidationRecommendations({
      checks,
      budgetResults,
      runtimeStatus,
      env,
    }),
  };
}

function hasBudgetFailure(report: VoiceLiveValidationReport): boolean {
  return (
    report.budgetResults?.some(
      (result) => result.actualMs !== undefined && !result.ok,
    ) ?? false
  );
}

if (import.meta.main) {
  try {
    const report = await runVoiceLiveValidation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (
      isTruthy(process.env.ELIZA_VOICE_FAIL_ON_BUDGET_MISS) &&
      hasBudgetFailure(report)
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    const payload = {
      mode: selectMode(process.env),
      ok: false,
      error: jsonError(error),
      details:
        error instanceof VoiceError && error.details
          ? jsonDetails(error.details)
          : null,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}
