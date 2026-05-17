import type { JsonValue } from "@elizaos/electrobun-carrots";
import type { TraceService } from "../trace/trace-service";
import { VoiceError } from "./errors";
import {
  cloneVoiceTurn,
  discoverStaticVoiceComponents,
  summarizeVoiceLatency,
} from "./voice-pipeline";
import {
  recordVoiceTraceStage,
  startVoiceTraceSession,
  voiceTraceAutoOpen,
  type VoiceTraceStage,
} from "./voice-trace";
import type {
  VoiceComponentSnapshot,
  VoiceInjectTranscriptParams,
  VoiceInterruptParams,
  VoiceLatencyMark,
  VoiceLatencySummary,
  VoicePipelineId,
  VoicePipelineSnapshot,
  VoicePipelineStatus,
  VoiceSpeakParams,
  VoiceStartParams,
  VoiceStopParams,
  VoiceTestMode,
  VoiceTurn,
  VoiceTurnId,
  VoiceTurnStatus,
} from "./types";

type VoiceServiceOptions = {
  traceService?: TraceService;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  pipelineIdFactory?: () => VoicePipelineId;
  turnIdFactory?: () => VoiceTurnId;
  apiBase?: string;
  token?: string | null;
};

type RuntimeVoiceSnapshot = {
  components: VoiceComponentSnapshot[];
  raw: JsonValue[];
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

export class VoiceService {
  private readonly traceService: TraceService | null;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly pipelineIdFactory: () => VoicePipelineId;
  private readonly turnIdFactory: () => VoiceTurnId;
  private readonly apiBase: string;
  private readonly token: string | null;
  private readonly pipelineId: VoicePipelineId;
  private statusValue: VoicePipelineStatus = "idle";
  private mode: VoiceTestMode = "mock";
  private activeTurn: VoiceTurn | null = null;
  private readonly recent: VoiceTurn[] = [];
  private traceEnabled = false;
  private autoOpenTraceView = false;
  private metadata: Record<string, JsonValue> | undefined;
  private error: string | undefined;

  constructor(options: VoiceServiceOptions = {}) {
    this.traceService = options.traceService ?? null;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.pipelineIdFactory = options.pipelineIdFactory ?? defaultPipelineId;
    this.turnIdFactory = options.turnIdFactory ?? defaultTurnId;
    this.apiBase =
      options.apiBase ??
      this.env.ELIZA_RUNTIME_API_BASE ??
      this.env.MILADY_DESKTOP_API_BASE ??
      "http://127.0.0.1:31337";
    this.token =
      options.token ??
      this.env.ELIZA_RUNTIME_API_TOKEN ??
      this.env.MILADY_API_TOKEN ??
      null;
    this.pipelineId = this.pipelineIdFactory();
  }

  async status(): Promise<VoicePipelineSnapshot> {
    return this.snapshot(await this.components());
  }

  async components(): Promise<VoiceComponentSnapshot[]> {
    const staticComponents = discoverStaticVoiceComponents();
    if (
      !isTruthy(this.env.ELIZA_VOICE_LIVE_RUNTIME) &&
      !isTruthy(this.env.ELIZA_VOICE_LIVE_AUDIO)
    ) {
      return staticComponents;
    }
    const runtime = await this.runtimeVoiceSnapshot();
    return mergeComponents(staticComponents, runtime.components);
  }

  async start(params: VoiceStartParams = {}): Promise<VoicePipelineSnapshot> {
    this.mode = params.mode ?? "mock";
    this.traceEnabled =
      params.trace === true || voiceTraceAutoOpen(this.env) || params.autoOpenTraceView === true;
    this.autoOpenTraceView =
      params.autoOpenTraceView === true || voiceTraceAutoOpen(this.env);
    this.metadata = params.metadata;
    this.error = undefined;
    this.statusValue = "listening";
    return this.status();
  }

  async stop(params: VoiceStopParams = {}): Promise<VoicePipelineSnapshot> {
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
      turn.transcriptFinal = text;
      await this.updateTurn("asr_final");
      const asrMark = await this.mark("asr", "final", { text });
      await this.trace("asr-final", "ASR final", turn.transcriptFinal, asrMark, {
        text,
      });
      this.statusValue = "thinking";
      await this.updateTurn("runtime_started");
      const runtimeMark = await this.mark("runtime", "runtime.started", {
        text,
      });
      await this.trace(
        "runtime-started",
        "Runtime handoff",
        turn.transcriptFinal,
        runtimeMark,
        { text },
      );
      await this.updateTurn("model_first_token");
      const modelMark = await this.mark("model", "first_token", {
        text: "mock",
      });
      await this.trace(
        "model-first-token",
        "Model first token",
        "mock",
        modelMark,
        { token: "mock" },
      );
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
    return summarizeVoiceLatency(this.activeTurn ?? this.recent[0]) ?? {};
  }

  async recentTurns(params: { limit?: number } = {}): Promise<VoiceTurn[]> {
    const limit = clampLimit(params.limit ?? 20, 1, 100);
    return this.recent.slice(0, limit).map(cloneVoiceTurn);
  }

  private async ensureTurn(params: {
    trace: boolean;
    metadata?: Record<string, JsonValue>;
  }): Promise<VoiceTurn> {
    if (this.activeTurn) {
      this.activeTurn.metadata = mergeMetadata(
        this.activeTurn.metadata,
        params.metadata,
      );
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
    const shouldTrace = this.traceEnabled || params.trace || this.autoOpenTraceView;
    if (shouldTrace && this.traceService) {
      const session = await startVoiceTraceSession({
        traceService: this.traceService,
        title: "Voice Turn",
        turnId: turn.id,
        pipelineId: this.pipelineId,
        openView: this.autoOpenTraceView,
        metadata: turn.metadata,
      });
      turn.traceSessionId = session.id;
    }
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
    await this.mark("turn", "started", { mode: this.mode });
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
      await this.trace("pipeline-error", "Voice pipeline error", message, undefined, {
        error: message ?? "error",
      });
    }
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
    return {
      id: this.pipelineId,
      status: this.statusValue,
      activeTurnId: this.activeTurn?.id,
      components,
      currentTurn: this.activeTurn ? cloneVoiceTurn(this.activeTurn) : undefined,
      recentTurns: this.recent.slice(0, 10).map(cloneVoiceTurn),
      latencySummary: summarizeVoiceLatency(this.activeTurn ?? this.recent[0]),
      error: this.error,
      updatedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private async runtimeVoiceSnapshot(): Promise<RuntimeVoiceSnapshot> {
    const raw: JsonValue[] = [];
    const components: VoiceComponentSnapshot[] = [];
    const voiceModels = await this.fetchJson("/api/local-inference/voice-models");
    raw.push({ route: "/api/local-inference/voice-models", payload: voiceModels });
    if (isRecord(voiceModels) && Array.isArray(voiceModels.installations)) {
      for (const installation of voiceModels.installations) {
        if (!isRecord(installation)) continue;
        const id = stringOrNull(installation.id);
        if (!id) continue;
        const installedVersion = stringOrNull(installation.installedVersion);
        components.push({
          id,
          name: id,
          role: idToRole(id),
          provider: id === "kokoro" || id === "omnivoice" ? id : "local-inference",
          status: installedVersion ? "available" : "missing",
          modelId: installedVersion ? `${id}@${installedVersion}` : undefined,
          error: stringOrNull(installation.lastError) ?? undefined,
          raw: installation,
        });
      }
    }
    return { components, raw };
  }

  private async fetchJson(path: string): Promise<JsonValue> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(
        `${this.apiBase.replace(/\/+$/, "")}${path}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          signal: controller.signal,
        },
      );
      const text = await response.text();
      const parsed = parseJsonValue(text);
      if (!response.ok) {
        throw new VoiceError(
          "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
          `Voice runtime route failed: ${path}`,
          { status: response.status, payload: parsed },
        );
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mergeComponents(
  staticComponents: VoiceComponentSnapshot[],
  runtimeComponents: VoiceComponentSnapshot[],
): VoiceComponentSnapshot[] {
  const merged = new Map<string, VoiceComponentSnapshot>();
  for (const component of staticComponents) merged.set(component.id, component);
  for (const component of runtimeComponents) {
    const current = merged.get(component.id);
    merged.set(component.id, current ? { ...current, ...component } : component);
  }
  return Array.from(merged.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: JsonValue): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idToRole(id: string): VoiceComponentSnapshot["role"] {
  if (id === "vad") return "vad";
  if (id === "asr") return "asr";
  if (id === "kokoro" || id === "omnivoice") return "tts";
  if (id.includes("turn")) return "turn-detection";
  if (id.includes("emotion")) return "emotion";
  return "voice";
}

function parseJsonValue(text: string): JsonValue {
  if (!text.trim()) return null;
  const parsed = JSON.parse(text) as JsonValue;
  return parsed;
}
