import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import type { TraceService } from "../trace/trace-service";
import { VoiceError } from "./errors";
import type {
  VoiceComponentSnapshot,
  VoiceInjectTranscriptParams,
  VoiceInterruptParams,
  VoiceLatencyMark,
  VoiceLatencySummary,
  VoicePartialRuntimeStreamingMode,
  VoicePipelineId,
  VoicePipelineSnapshot,
  VoicePipelineStatus,
  VoiceRuntimeStatus,
  VoiceSpeakParams,
  VoiceStartParams,
  VoiceStopParams,
  VoiceSynthesisResult,
  VoiceSynthesizeSpeechParams,
  VoiceTestMode,
  VoiceTranscribeAudioParams,
  VoiceTurn,
  VoiceTurnId,
  VoiceTurnStatus,
} from "./types";
import {
  evaluateVoiceLatencyBudget,
  getVoiceLatencyBudgetFromEnv,
  type VoiceLatencyBudget,
  type VoiceLatencyBudgetResult,
} from "./voice-latency-budget";
import {
  cloneVoiceTurn,
  discoverStaticVoiceComponents,
  summarizeVoiceLatency,
} from "./voice-pipeline";
import {
  RuntimeHttpVoiceAdapter,
  type VoiceRuntimeAdapter,
} from "./voice-runtime-adapter";
import {
  recordVoiceTraceStage,
  startVoiceTraceSession,
  type VoiceTraceStage,
  voiceTraceAutoOpen,
} from "./voice-trace";

type VoiceServiceOptions = {
  traceService?: TraceService;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  pipelineIdFactory?: () => VoicePipelineId;
  turnIdFactory?: () => VoiceTurnId;
  apiBase?: string;
  token?: string | null;
  runtimeAdapter?: VoiceRuntimeAdapter;
};

function defaultPipelineId(): VoicePipelineId {
  return `voice-pipeline-${crypto.randomUUID()}`;
}

function defaultTurnId(): VoiceTurnId {
  return `voice-turn-${crypto.randomUUID()}`;
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

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VoiceError(
      "VOICE_REQUEST_FAILED",
      `${field} must be a non-empty string.`,
    );
  }
  return trimmed;
}

function mergeMetadata(
  left: Record<string, JsonValue> | undefined,
  right: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (!left && !right) return undefined;
  return { ...(left ?? {}), ...(right ?? {}) };
}

function latencySummaryJson(
  summary: VoiceLatencySummary,
): Record<string, JsonValue> {
  const json: Record<string, JsonValue> = {};
  if (summary.inputToVadMs !== undefined)
    json.inputToVadMs = summary.inputToVadMs;
  if (summary.vadToAsrPartialMs !== undefined) {
    json.vadToAsrPartialMs = summary.vadToAsrPartialMs;
  }
  if (summary.asrPartialToRuntimePrepareMs !== undefined) {
    json.asrPartialToRuntimePrepareMs = summary.asrPartialToRuntimePrepareMs;
  }
  if (summary.asrFinalToRuntimeCommitMs !== undefined) {
    json.asrFinalToRuntimeCommitMs = summary.asrFinalToRuntimeCommitMs;
  }
  if (summary.runtimeToFirstTokenMs !== undefined) {
    json.runtimeToFirstTokenMs = summary.runtimeToFirstTokenMs;
  }
  if (summary.firstTokenToTtsRequestMs !== undefined) {
    json.firstTokenToTtsRequestMs = summary.firstTokenToTtsRequestMs;
  }
  if (summary.ttsRequestToFirstAudioMs !== undefined) {
    json.ttsRequestToFirstAudioMs = summary.ttsRequestToFirstAudioMs;
  }
  if (summary.ttsFirstAudioToPlaybackMs !== undefined) {
    json.ttsFirstAudioToPlaybackMs = summary.ttsFirstAudioToPlaybackMs;
  }
  if (summary.totalToFirstTokenMs !== undefined) {
    json.totalToFirstTokenMs = summary.totalToFirstTokenMs;
  }
  if (summary.totalToFirstAudioMs !== undefined) {
    json.totalToFirstAudioMs = summary.totalToFirstAudioMs;
  }
  if (summary.totalToPlaybackMs !== undefined) {
    json.totalToPlaybackMs = summary.totalToPlaybackMs;
  }
  return json;
}

function budgetResultsJson(
  results: VoiceLatencyBudgetResult[],
): Record<string, JsonValue>[] {
  return results.map((result) => ({
    stage: result.stage,
    actualMs: result.actualMs ?? null,
    budgetMs: result.budgetMs,
    ok: result.ok,
  }));
}

export class VoiceService {
  private readonly traceService: TraceService | null;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly pipelineIdFactory: () => VoicePipelineId;
  private readonly turnIdFactory: () => VoiceTurnId;
  private readonly apiBase: string;
  private readonly token: string | null;
  private readonly runtimeAdapter: VoiceRuntimeAdapter;
  private readonly pipelineId: VoicePipelineId;
  private readonly latencyBudget: VoiceLatencyBudget;
  private statusValue: VoicePipelineStatus = "idle";
  private mode: VoiceTestMode = "mock";
  private activeTurn: VoiceTurn | null = null;
  private readonly recent: VoiceTurn[] = [];
  private traceEnabled = false;
  private autoOpenTraceView = false;
  private metadata: Record<string, JsonValue> | undefined;
  private error: string | undefined;
  private traceSessionReady: Promise<void> | null = null;
  private readonly unsubscriptions: Array<() => void> = [];
  private runtimeCommitTurnId: VoiceTurnId | null = null;

  constructor(options: VoiceServiceOptions = {}) {
    this.traceService = options.traceService ?? null;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.pipelineIdFactory = options.pipelineIdFactory ?? defaultPipelineId;
    this.turnIdFactory = options.turnIdFactory ?? defaultTurnId;
    this.apiBase =
      options.apiBase ??
      this.env.ELIZA_RUNTIME_API_BASE ??
      this.env.ELIZA_DESKTOP_API_BASE ??
      "http://127.0.0.1:31337";
    this.token =
      options.token ??
      this.env.ELIZA_RUNTIME_API_TOKEN ??
      this.env.ELIZA_API_TOKEN ??
      null;
    this.runtimeAdapter =
      options.runtimeAdapter ??
      new RuntimeHttpVoiceAdapter({
        env: this.env,
        apiBase: this.apiBase,
        token: this.token,
      });
    this.pipelineId = this.pipelineIdFactory();
    this.latencyBudget = getVoiceLatencyBudgetFromEnv(this.env);
  }

  async status(): Promise<VoicePipelineSnapshot> {
    return this.snapshot(await this.components());
  }

  async components(): Promise<VoiceComponentSnapshot[]> {
    if (
      !isTruthy(this.env.ELIZA_VOICE_LIVE_RUNTIME) &&
      !isTruthy(this.env.ELIZA_VOICE_LIVE_AUDIO)
    ) {
      return discoverStaticVoiceComponents();
    }
    return this.runtimeAdapter.components();
  }

  async start(params: VoiceStartParams = {}): Promise<VoicePipelineSnapshot> {
    this.mode = params.mode ?? "mock";
    this.traceEnabled =
      params.trace === true ||
      voiceTraceAutoOpen(this.env) ||
      params.autoOpenTraceView === true;
    this.autoOpenTraceView =
      params.autoOpenTraceView === true || voiceTraceAutoOpen(this.env);
    this.metadata = params.metadata;
    this.error = undefined;
    if (this.mode === "local-runtime" || this.mode === "live-audio") {
      this.assertLiveModeEnabled(this.mode);
      this.statusValue = "listening";
      this.bindRuntimeAdapter();
      await this.runtimeAdapter.startListening({
        ...params,
        mode: this.mode,
      });
      return this.status();
    }
    this.statusValue = "listening";
    return this.status();
  }

  async stop(params: VoiceStopParams = {}): Promise<VoicePipelineSnapshot> {
    if (this.mode === "local-runtime" || this.mode === "live-audio") {
      await this.runtimeAdapter.stopListening(params);
      this.unbindRuntimeAdapter();
    }
    if (this.activeTurn && this.activeTurn.status !== "completed") {
      await this.finishTurn("interrupted", params.reason ?? "stopped");
    }
    this.statusValue = "idle";
    return this.status();
  }

  async interrupt(
    params: VoiceInterruptParams = {},
  ): Promise<VoicePipelineSnapshot> {
    this.requireRunning();
    if (this.mode === "local-runtime" || this.mode === "live-audio") {
      await this.runtimeAdapter.interrupt(params);
    }
    if (this.activeTurn) {
      await this.finishTurn("interrupted", params.reason ?? "interrupted");
    }
    this.statusValue = "interrupted";
    return this.status();
  }

  async injectTranscript(
    params: VoiceInjectTranscriptParams,
  ): Promise<VoiceTurn> {
    this.requireRunning();
    const text = requireNonEmpty(params.text, "text");
    const turn = await this.ensureTurn({
      trace: params.trace === true,
      metadata: { mode: this.mode },
    });
    if (params.final === true) {
      await this.handleAsrFinal({ text }, params.trace === true);
      return cloneVoiceTurn(turn);
    }

    turn.transcriptPartial = text;
    this.statusValue = "transcribing";
    await this.updateTurn("asr_partial");
    const mark = await this.mark("asr", "partial", { text });
    await this.trace("asr-partial", "ASR partial", text, mark, { text });
    return cloneVoiceTurn(turn);
  }

  async speak(params: VoiceSpeakParams): Promise<VoiceTurn> {
    this.requireRunning();
    const text = requireNonEmpty(params.text, "text");
    if (
      (this.mode === "local-runtime" || this.mode === "live-audio") &&
      this.runtimeAdapter.synthesizeSpeech
    ) {
      await this.synthesizeSpeech(params);
      return cloneVoiceTurn(this.recent[0] ?? this.requireActiveTurn());
    }
    const turn = await this.ensureTurn({
      trace: params.trace === true,
      metadata: params.voiceId ? { voiceId: params.voiceId } : undefined,
    });
    turn.responseText = text;
    this.statusValue = "speaking";
    await this.updateTurn("tts_started");
    const started = await this.mark("tts", "started", {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.trace("tts-started", "TTS started", text, started, {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.updateTurn("tts_first_audio");
    const firstAudio = await this.mark("tts", "first_audio", {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.trace("tts-first-audio", "TTS first audio", text, firstAudio, {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.updateTurn("playback_started");
    const playback = await this.mark("playback", "started", {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.trace("playback-started", "Playback started", text, playback, {
      text,
      voiceId: params.voiceId ?? null,
    });
    await this.finishTurn("completed");
    this.statusValue = "listening";
    return cloneVoiceTurn(turn);
  }

  async latency(): Promise<VoiceLatencySummary> {
    const summary =
      summarizeVoiceLatency(this.activeTurn ?? this.recent[0]) ?? {};
    return {
      ...summary,
      budgetResults: evaluateVoiceLatencyBudget(summary, this.latencyBudget),
    };
  }

  async recentTurns(params: { limit?: number } = {}): Promise<VoiceTurn[]> {
    const limit = clampLimit(params.limit ?? 20, 1, 100);
    return this.recent.slice(0, limit).map(cloneVoiceTurn);
  }

  async transcribeAudio(
    params: VoiceTranscribeAudioParams,
  ): Promise<VoiceTurn> {
    this.requireRunning();
    if (!this.runtimeAdapter.transcribeAudio) {
      throw new VoiceError(
        "VOICE_ASR_UNAVAILABLE",
        "The active voice runtime does not expose ASR transcription.",
      );
    }
    const event = await this.runtimeAdapter.transcribeAudio(params);
    await this.handleAsrFinal(event, params.trace === true);
    return cloneVoiceTurn(this.requireActiveTurn());
  }

  async synthesizeSpeech(
    params: VoiceSynthesizeSpeechParams,
  ): Promise<VoiceSynthesisResult> {
    this.requireRunning();
    if (!this.runtimeAdapter.synthesizeSpeech) {
      throw new VoiceError(
        "VOICE_TTS_UNAVAILABLE",
        "The active voice runtime does not expose speech synthesis.",
      );
    }
    const result = await this.runtimeAdapter.synthesizeSpeech(params);
    await this.handleTtsResult(params, result);
    return result;
  }

  private async ensureTurn(params: {
    trace: boolean;
    metadata?: Record<string, JsonValue>;
    initialDetection?: boolean;
  }): Promise<VoiceTurn> {
    if (this.activeTurn) {
      this.activeTurn.metadata = mergeMetadata(
        this.activeTurn.metadata,
        params.metadata,
      );
      const shouldTrace =
        this.traceEnabled || params.trace || this.autoOpenTraceView;
      if (shouldTrace) {
        await this.ensureTraceSession(this.activeTurn);
      }
      return this.activeTurn;
    }
    const createdAt = this.timestamp();
    const turn: VoiceTurn = {
      id: this.turnIdFactory(),
      pipelineId: this.pipelineId,
      status: "started",
      marks: [],
      createdAt,
      updatedAt: createdAt,
      metadata: mergeMetadata(this.metadata, params.metadata),
    };
    this.activeTurn = turn;
    const shouldTrace =
      this.traceEnabled || params.trace || this.autoOpenTraceView;
    if (shouldTrace) {
      await this.ensureTraceSession(turn);
    }
    if (params.initialDetection !== false) {
      this.statusValue = "detecting";
      const input = await this.mark("input", "audio.input", {
        mode: this.mode,
      });
      const vad = await this.mark("vad", "speech.detected", {
        mode: this.mode,
      });
      await this.trace("vad", "Voice activity detected", undefined, vad, {
        inputOffsetMs: input.offsetMs ?? null,
        mode: this.mode,
      });
      const turnMark = await this.mark("turn", "started", { mode: this.mode });
      await this.trace(
        "turn-started",
        "Voice turn started",
        undefined,
        turnMark,
        {
          mode: this.mode,
        },
      );
    }
    return turn;
  }

  private async mark(
    stage: VoiceLatencyMark["stage"],
    name: string,
    metadata?: Record<string, JsonValue>,
  ): Promise<VoiceLatencyMark> {
    const turn = this.requireActiveTurn();
    const timestamp = this.timestamp();
    const offsetMs = Math.max(
      0,
      Date.parse(timestamp) - Date.parse(turn.createdAt),
    );
    const previous = turn.marks[turn.marks.length - 1];
    const durationMs = previous
      ? Math.max(0, Date.parse(timestamp) - Date.parse(previous.timestamp))
      : 0;
    const mark: VoiceLatencyMark = {
      stage,
      name,
      timestamp,
      offsetMs,
      durationMs,
      metadata,
    };
    turn.marks.push(mark);
    turn.updatedAt = timestamp;
    return mark;
  }

  private async updateTurn(status: VoiceTurnStatus): Promise<void> {
    const turn = this.requireActiveTurn();
    turn.status = status;
    turn.updatedAt = this.timestamp();
  }

  private async finishTurn(
    status: "completed" | "interrupted" | "error",
    message?: string,
  ): Promise<void> {
    const turn = this.requireActiveTurn();
    turn.status = status;
    turn.updatedAt = this.timestamp();
    turn.completedAt = turn.updatedAt;
    if (message) turn.error = message;
    if (status === "error") {
      await this.trace(
        "pipeline-error",
        "Voice pipeline error",
        message,
        undefined,
        {
          error: message ?? "error",
        },
      );
    }
    const latencySummary = summarizeVoiceLatency(turn) ?? {};
    const budgetResults = evaluateVoiceLatencyBudget(
      latencySummary,
      this.latencyBudget,
    );
    await this.trace(
      "latency-budget",
      "Voice latency budget",
      undefined,
      undefined,
      {
        summary: latencySummaryJson(latencySummary),
        results: budgetResultsJson(budgetResults),
      },
    );
    if (turn.traceSessionId && this.traceService) {
      if (status === "completed") {
        await this.traceService.completeSession({
          sessionId: turn.traceSessionId,
          metadata: { turnStatus: status },
        });
      } else if (status === "interrupted") {
        await this.traceService.cancelSession({
          sessionId: turn.traceSessionId,
          reason: message,
        });
      } else {
        await this.traceService.errorSession({
          sessionId: turn.traceSessionId,
          error: message ?? "Voice pipeline error",
        });
      }
    }
    this.recent.unshift(cloneVoiceTurn(turn));
    this.recent.splice(20);
    this.activeTurn = null;
    this.runtimeCommitTurnId = null;
    this.traceSessionReady = null;
  }

  private async ensureTraceSession(turn: VoiceTurn): Promise<void> {
    if (!this.traceService || turn.traceSessionId) return;
    this.traceSessionReady ??= startVoiceTraceSession({
      traceService: this.traceService,
      title: "Voice Turn",
      turnId: turn.id,
      pipelineId: this.pipelineId,
      openView: this.autoOpenTraceView,
      metadata: turn.metadata,
    }).then((session) => {
      turn.traceSessionId = session.id;
    });
    await this.traceSessionReady;
  }

  private async trace(
    stage: VoiceTraceStage,
    title: string,
    text: string | undefined,
    mark: VoiceLatencyMark | undefined,
    payload: JsonValue,
  ): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;
    await recordVoiceTraceStage({
      traceService: this.traceService,
      turn,
      stage,
      title,
      text,
      mark,
      payload,
    });
  }

  private assertLiveModeEnabled(mode: VoiceTestMode): void {
    if (
      mode === "local-runtime" &&
      !isTruthy(this.env.ELIZA_VOICE_LIVE_RUNTIME)
    ) {
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        "Local runtime voice mode is disabled. Set ELIZA_VOICE_LIVE_RUNTIME=1 to enable it.",
      );
    }
    if (mode === "live-audio" && !isTruthy(this.env.ELIZA_VOICE_LIVE_AUDIO)) {
      throw new VoiceError(
        "VOICE_AUDIO_INPUT_UNAVAILABLE",
        "Live audio is disabled. Set ELIZA_VOICE_LIVE_AUDIO=1 to enable it.",
      );
    }
  }

  private bindRuntimeAdapter(): void {
    if (this.unsubscriptions.length > 0) return;
    this.unsubscriptions.push(
      this.runtimeAdapter.onVad((event) => {
        void this.handleVad(event);
      }),
      this.runtimeAdapter.onTurn((event) => {
        void this.handleTurn(event);
      }),
      this.runtimeAdapter.onAsrPartial((event) => {
        void this.handleAsrPartial(event);
      }),
      this.runtimeAdapter.onAsrFinal((event) => {
        void this.handleAsrFinal(event, this.traceEnabled);
      }),
      this.runtimeAdapter.onPlayback((event) => {
        void this.handlePlayback(event);
      }),
      this.runtimeAdapter.onError((event) => {
        void this.handleRuntimeError(event);
      }),
    );
    if (this.runtimeAdapter.onTtsChunk) {
      this.unsubscriptions.push(
        this.runtimeAdapter.onTtsChunk((event) => {
          void this.handleTtsChunk(event);
        }),
      );
    }
  }

  private unbindRuntimeAdapter(): void {
    while (this.unsubscriptions.length > 0) {
      this.unsubscriptions.pop()?.();
    }
  }

  private async handleVad(event: {
    active: boolean;
    score?: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    if (!event.active) return;
    const turn = await this.ensureTurn({
      trace: this.traceEnabled,
      metadata: event.metadata,
      initialDetection: false,
    });
    this.statusValue = "detecting";
    if (!turn.marks.some((mark) => mark.stage === "input")) {
      await this.mark("input", "audio.input", { mode: this.mode });
    }
    const mark = await this.mark("vad", "speech.detected", {
      score: event.score ?? null,
      mode: this.mode,
    });
    await this.trace("vad", "Voice activity detected", undefined, mark, {
      score: event.score ?? null,
      mode: this.mode,
    });
  }

  private async handleTurn(event: {
    status: "started" | "ended" | "cancelled" | "error";
    reason?: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    if (event.status === "started") {
      await this.ensureTurn({
        trace: this.traceEnabled,
        metadata: event.metadata,
        initialDetection: false,
      });
      if (
        !this.requireActiveTurn().marks.some((mark) => mark.stage === "turn")
      ) {
        const mark = await this.mark("turn", "started", { mode: this.mode });
        await this.trace(
          "turn-started",
          "Voice turn started",
          undefined,
          mark,
          {
            mode: this.mode,
          },
        );
      }
      return;
    }
    if (!this.activeTurn) return;
    if (event.status === "cancelled") {
      await this.finishTurn("interrupted", event.reason ?? "cancelled");
      return;
    }
    if (event.status === "error") {
      await this.finishTurn("error", event.reason ?? "Voice turn failed.");
    }
  }

  private async handleAsrPartial(event: {
    text: string;
    synthetic?: boolean;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    const text = requireNonEmpty(event.text, "text");
    const turn = await this.ensureTurn({
      trace: this.traceEnabled,
      metadata: event.metadata,
      initialDetection: false,
    });
    turn.transcriptPartial = text;
    this.statusValue = "transcribing";
    await this.updateTurn("asr_partial");
    const mark = await this.mark("asr", "partial", {
      text,
      synthetic: event.synthetic === true,
    });
    await this.trace("asr-partial", "ASR partial", text, mark, {
      text,
      synthetic: event.synthetic === true,
    });
    const mode = await this.partialRuntimeStreamingMode();
    if (mode === "prepare-only" || mode === "draft-api") {
      const prepareMark = await this.mark("runtime", "prepare.started", {
        text,
        mode,
      });
      await this.trace(
        mode === "draft-api"
          ? "model-prepare-started"
          : "model-prepare-skipped",
        mode === "draft-api"
          ? "Runtime prepare started"
          : "Runtime prepare skipped",
        text,
        prepareMark,
        {
          text,
          partialRuntimeStreamingMode: mode,
          reason:
            mode === "prepare-only"
              ? "No draft runtime API is available."
              : null,
        },
      );
    }
  }

  private async handleAsrFinal(
    event: { text: string; metadata?: Record<string, JsonValue> },
    trace: boolean,
  ): Promise<void> {
    const text = requireNonEmpty(event.text, "text");
    const turn = await this.ensureTurn({
      trace,
      metadata: event.metadata,
      initialDetection: false,
    });
    turn.transcriptFinal = text;
    await this.updateTurn("asr_final");
    const asrMark = await this.mark("asr", "final", { text });
    await this.trace("asr-final", "ASR final", turn.transcriptFinal, asrMark, {
      text,
    });
    if (this.runtimeCommitTurnId === turn.id) return;
    this.runtimeCommitTurnId = turn.id;
    await this.handoffToRuntime(text);
  }

  private async handoffToRuntime(text: string): Promise<void> {
    this.statusValue = "thinking";
    await this.updateTurn("runtime_started");
    const runtimeMark = await this.mark("runtime", "runtime.started", {
      text,
    });
    await this.trace("runtime-started", "Runtime handoff", text, runtimeMark, {
      text,
    });
    let firstTokenText = "mock";
    let responseText: string | undefined;
    let raw: JsonValue | undefined;
    if (
      (this.mode === "local-runtime" || this.mode === "live-audio") &&
      this.runtimeAdapter.sendRuntimeMessage
    ) {
      const result = await this.runtimeAdapter.sendRuntimeMessage({ text });
      firstTokenText = result.firstTokenText ?? result.responseText ?? "";
      responseText = result.responseText;
      raw = result.raw;
    }
    await this.updateTurn("model_first_token");
    const modelMark = await this.mark("model", "first_token", {
      text: firstTokenText,
    });
    await this.trace(
      "model-first-token",
      "Model first token",
      firstTokenText,
      modelMark,
      { token: firstTokenText, raw: raw ?? null },
    );
    if (responseText) {
      this.requireActiveTurn().responseText = responseText;
      if (isTruthy(this.env.ELIZA_VOICE_TRACE_MODEL_DELTAS)) {
        await this.trace(
          "model-delta",
          "Model delta",
          responseText,
          modelMark,
          { text: responseText },
        );
      }
    }
  }

  private async handleTtsResult(
    params: VoiceSynthesizeSpeechParams,
    result: VoiceSynthesisResult,
  ): Promise<void> {
    const turn = await this.ensureTurn({
      trace: params.trace === true,
      metadata: mergeMetadata(params.metadata, {
        voiceId: params.voiceId ?? result.voiceId ?? null,
      }),
      initialDetection: false,
    });
    turn.responseText = params.text;
    this.statusValue = "speaking";
    await this.updateTurn("tts_started");
    const started = await this.mark("tts", "started", {
      text: params.text,
      voiceId: params.voiceId ?? result.voiceId ?? null,
      provider: result.provider ?? null,
    });
    await this.trace("tts-started", "TTS started", params.text, started, {
      text: params.text,
      voiceId: params.voiceId ?? result.voiceId ?? null,
      provider: result.provider ?? null,
    });
    await this.updateTurn("tts_first_audio");
    const firstAudio = await this.mark("tts", "first_audio", {
      byteLength: result.byteLength,
      mimeType: result.mimeType,
    });
    await this.trace(
      "tts-first-audio",
      "TTS first audio",
      params.text,
      firstAudio,
      {
        byteLength: result.byteLength,
        mimeType: result.mimeType,
      },
    );
    if (!this.runtimeAdapter.playAudio) {
      await this.finishTurn("error", "Voice playback is unavailable.");
      throw new VoiceError(
        "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
        "The active voice runtime does not expose audio playback.",
      );
    }
    try {
      const playback = await this.runtimeAdapter.playAudio({
        audioBase64: result.audioBase64,
        mimeType: result.mimeType,
        trace: params.trace,
        metadata: params.metadata,
      });
      await this.handlePlayback(playback);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Voice playback failed.";
      await this.finishTurn("error", message);
      throw error;
    }
  }

  private async handleTtsChunk(event: {
    audioBase64: string;
    mimeType: string;
    byteLength: number;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    await this.handleTtsResult(
      { text: this.activeTurn?.responseText ?? "", metadata: event.metadata },
      {
        audioBase64: event.audioBase64,
        mimeType: event.mimeType,
        byteLength: event.byteLength,
      },
    );
  }

  private async handlePlayback(event: {
    started: boolean;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    if (!event.started || !this.activeTurn) return;
    await this.updateTurn("playback_started");
    const playback = await this.mark("playback", "started", event.metadata);
    await this.trace(
      "playback-started",
      "Playback started",
      this.activeTurn.responseText,
      playback,
      event.metadata ?? {},
    );
    await this.finishTurn("completed");
    this.statusValue = "listening";
  }

  private async handleRuntimeError(event: {
    code?: string;
    message: string;
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    this.error = event.message;
    this.statusValue = "error";
    if (this.activeTurn) {
      await this.finishTurn("error", event.message);
    }
  }

  private requireRunning(): void {
    if (this.statusValue === "idle" || this.statusValue === "error") {
      throw new VoiceError(
        "VOICE_PIPELINE_NOT_RUNNING",
        "Voice pipeline is not running.",
      );
    }
  }

  private requireActiveTurn(): VoiceTurn {
    if (!this.activeTurn) {
      throw new VoiceError("VOICE_TURN_NOT_FOUND", "No active voice turn.");
    }
    return this.activeTurn;
  }

  private async snapshot(
    components: VoiceComponentSnapshot[],
  ): Promise<VoicePipelineSnapshot> {
    const runtimeStatus = await this.runtimeAdapter.status();
    const latencySummary = await this.latency();
    const partialRuntimeStreamingMode =
      await this.partialRuntimeStreamingMode(runtimeStatus);
    return {
      id: this.pipelineId,
      status: this.statusValue,
      activeTurnId: this.activeTurn?.id,
      components,
      currentTurn: this.activeTurn
        ? cloneVoiceTurn(this.activeTurn)
        : undefined,
      recentTurns: this.recent.slice(0, 10).map(cloneVoiceTurn),
      latencySummary,
      latencyBudget: this.latencyBudget,
      latencyBudgetResults: latencySummary.budgetResults,
      partialRuntimeStreamingSupported:
        runtimeStatus.runtimeDraftSupport === true,
      partialRuntimeStreamingEnabled: isTruthy(
        this.env.ELIZA_VOICE_STREAM_ASR_PARTIALS,
      ),
      partialRuntimeStreamingMode,
      ttsStreamingSupported: runtimeStatus.ttsStreamingSupport,
      playbackAckSupported: runtimeStatus.playbackAckSupport,
      error: this.error,
      updatedAt: this.timestamp(),
    };
  }

  private async partialRuntimeStreamingMode(
    runtimeStatus?: VoiceRuntimeStatus,
  ): Promise<VoicePartialRuntimeStreamingMode> {
    if (!isTruthy(this.env.ELIZA_VOICE_STREAM_ASR_PARTIALS)) {
      return "disabled";
    }
    const status = runtimeStatus ?? (await this.runtimeAdapter.status());
    return status.runtimeDraftSupport === true ? "draft-api" : "prepare-only";
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
