import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { VoiceError } from "./errors";
import type {
  VoiceAsrFinalEvent,
  VoiceAsrPartialEvent,
  VoiceLatencyMark,
  VoiceLatencySummary,
  VoicePartialRuntimeStreamingMode,
  VoicePipelineId,
  VoicePlaybackEvent,
  VoiceTurn,
  VoiceTurnId,
  VoiceVadEvent,
} from "./types";
import { summarizeVoiceLatency } from "./voice-pipeline";
import { type VoiceTtsChunk, VoiceTtsChunker } from "./voice-tts-chunker";

type VoiceStreamCoordinatorOptions = {
  pipelineId: VoicePipelineId;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  turnIdFactory?: () => VoiceTurnId;
  runtimeDraftSupported?: boolean;
  ttsChunker?: VoiceTtsChunker;
};

type VoiceStreamTurnStartParams = {
  traceSessionId?: string;
  metadata?: Record<string, JsonValue>;
};

export type VoiceAsrPartialHandlingResult = {
  mode: VoicePartialRuntimeStreamingMode;
  runtimePrepareStarted: boolean;
};

export type VoiceRuntimeDeltaResult = {
  firstToken: boolean;
  chunks: VoiceTtsChunk[];
};

function defaultTurnId(): VoiceTurnId {
  return `voice-turn-${crypto.randomUUID()}`;
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function cloneTurn(turn: VoiceTurn): VoiceTurn {
  return {
    ...turn,
    marks: turn.marks.map((mark) => ({
      ...mark,
      metadata: mark.metadata ? { ...mark.metadata } : undefined,
    })),
    metadata: turn.metadata ? { ...turn.metadata } : undefined,
  };
}

export class VoiceStreamCoordinator {
  private readonly pipelineId: VoicePipelineId;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly turnIdFactory: () => VoiceTurnId;
  private readonly runtimeDraftSupported: boolean;
  private readonly ttsChunker: VoiceTtsChunker;
  private activeTurn: VoiceTurn | null = null;
  private committedFinal = false;
  private sawFirstToken = false;

  constructor(options: VoiceStreamCoordinatorOptions) {
    this.pipelineId = options.pipelineId;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.turnIdFactory = options.turnIdFactory ?? defaultTurnId;
    this.runtimeDraftSupported = options.runtimeDraftSupported === true;
    this.ttsChunker =
      options.ttsChunker ??
      new VoiceTtsChunker({ env: this.env, now: () => this.now().getTime() });
  }

  async startTurn(params: VoiceStreamTurnStartParams = {}): Promise<VoiceTurn> {
    if (this.activeTurn) return cloneTurn(this.activeTurn);
    const timestamp = this.timestamp();
    this.activeTurn = {
      id: this.turnIdFactory(),
      pipelineId: this.pipelineId,
      traceSessionId: params.traceSessionId,
      status: "started",
      marks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: params.metadata,
    };
    this.committedFinal = false;
    this.sawFirstToken = false;
    this.ttsChunker.reset();
    this.mark("input", "audio.input");
    return cloneTurn(this.activeTurn);
  }

  async handleVad(event: VoiceVadEvent): Promise<void> {
    if (!event.active) return;
    this.requireTurn();
    this.mark("vad", "speech.detected", {
      score: event.score ?? null,
      ...(event.metadata ?? {}),
    });
  }

  async handleAsrPartial(
    event: VoiceAsrPartialEvent,
  ): Promise<VoiceAsrPartialHandlingResult> {
    const turn = this.requireTurn();
    turn.transcriptPartial = event.text;
    turn.status = "asr_partial";
    this.mark("asr", "partial", {
      text: event.text,
      synthetic: event.synthetic === true,
      ...(event.metadata ?? {}),
    });
    const mode = this.partialStreamingMode();
    if (mode === "prepare-only" || mode === "draft-api") {
      this.mark("runtime", "prepare.started", {
        text: event.text,
        mode,
      });
    }
    return {
      mode,
      runtimePrepareStarted: mode === "prepare-only" || mode === "draft-api",
    };
  }

  async handleAsrFinal(event: VoiceAsrFinalEvent): Promise<boolean> {
    const turn = this.requireTurn();
    turn.transcriptFinal = event.text;
    turn.status = "asr_final";
    this.mark("asr", "final", {
      text: event.text,
      ...(event.metadata ?? {}),
    });
    if (this.committedFinal) return false;
    this.committedFinal = true;
    turn.status = "runtime_started";
    this.mark("runtime", "runtime.started", { text: event.text });
    return true;
  }

  async handleRuntimeDelta(text: string): Promise<VoiceRuntimeDeltaResult> {
    const turn = this.requireTurn();
    turn.responseText = `${turn.responseText ?? ""}${text}`;
    let firstToken = false;
    if (!this.sawFirstToken && text.trim()) {
      this.sawFirstToken = true;
      firstToken = true;
      turn.status = "model_first_token";
      this.mark("model", "first_token", { text });
    }
    const chunks = this.ttsChunker.pushDelta(text);
    if (
      chunks.length > 0 &&
      !turn.marks.some(
        (mark) => mark.stage === "tts" && mark.name === "started",
      )
    ) {
      turn.status = "tts_started";
      this.mark("tts", "started", {
        chunkSequence: chunks[0]?.sequence ?? null,
      });
    }
    return { firstToken, chunks };
  }

  async handleRuntimeDone(): Promise<VoiceTtsChunk[]> {
    this.requireTurn();
    return this.ttsChunker.flush();
  }

  async handleTtsFirstAudio(event?: {
    metadata?: Record<string, JsonValue>;
  }): Promise<void> {
    const turn = this.requireTurn();
    turn.status = "tts_first_audio";
    this.mark("tts", "first_audio", event?.metadata);
  }

  async handlePlaybackStarted(event: VoicePlaybackEvent): Promise<void> {
    if (!event.started) return;
    const turn = this.requireTurn();
    turn.status = "playback_started";
    this.mark("playback", "started", event.metadata);
  }

  async interrupt(reason = "interrupted"): Promise<void> {
    const turn = this.requireTurn();
    turn.status = "interrupted";
    turn.error = reason;
    turn.completedAt = this.timestamp();
    turn.updatedAt = turn.completedAt;
    this.ttsChunker.reset();
  }

  async stop(reason = "stopped"): Promise<void> {
    if (!this.activeTurn) return;
    await this.interrupt(reason);
    this.activeTurn = null;
  }

  snapshot(): VoiceTurn | null {
    return this.activeTurn ? cloneTurn(this.activeTurn) : null;
  }

  latencySummary(): VoiceLatencySummary | undefined {
    return summarizeVoiceLatency(this.activeTurn ?? undefined);
  }

  partialStreamingMode(): VoicePartialRuntimeStreamingMode {
    if (!truthy(this.env.ELIZA_VOICE_STREAM_ASR_PARTIALS)) {
      return "disabled";
    }
    return this.runtimeDraftSupported ? "draft-api" : "prepare-only";
  }

  private mark(
    stage: VoiceLatencyMark["stage"],
    name: string,
    metadata?: Record<string, JsonValue>,
  ): VoiceLatencyMark {
    const turn = this.requireTurn();
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

  private requireTurn(): VoiceTurn {
    if (!this.activeTurn) {
      throw new VoiceError("VOICE_TURN_NOT_FOUND", "No active voice turn.");
    }
    return this.activeTurn;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
