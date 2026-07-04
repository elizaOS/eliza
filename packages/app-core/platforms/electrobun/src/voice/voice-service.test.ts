/** Exercises voice service behavior with deterministic app-core test fixtures. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { TraceService } from "../trace/trace-service";
import { TraceStore } from "../trace/trace-store";
import { VoiceError } from "./errors";
import type {
  VoiceAsrFinalEvent,
  VoiceAsrPartialEvent,
  VoiceComponentSnapshot,
  VoicePlaybackEvent,
  VoiceRuntimeErrorEvent,
  VoiceRuntimeHandoffParams,
  VoiceRuntimeHandoffResult,
  VoiceRuntimeStatus,
  VoiceSynthesisResult,
  VoiceSynthesizeSpeechParams,
  VoiceTranscribeAudioParams,
  VoiceTurnEvent,
  VoiceVadEvent,
} from "./types";
import type { VoiceRuntimeAdapter } from "./voice-runtime-adapter";
import { VoiceService } from "./voice-service";

class FakeCanvas {
  readonly windows: Array<{ id: string; url?: string; title?: string }> = [];
  readonly pushes: Array<{ id: string; payload: JsonValue }> = [];

  async createWindow(options: {
    url?: string;
    title?: string;
  }): Promise<{ id: string }> {
    const id = `canvas-${this.windows.length + 1}`;
    this.windows.push({ id, url: options.url, title: options.title });
    return { id };
  }

  async destroyWindow(): Promise<void> {}

  async a2uiPush(options: { id: string; payload: JsonValue }): Promise<void> {
    this.pushes.push(options);
  }
}

class FakeWorkerStatusProvider {
  getWorkerStatus(id: string): { state: string } | null {
    return id === "eliza.runtime" ? { state: "running" } : null;
  }
}

class MockVoiceRuntimeAdapter implements VoiceRuntimeAdapter {
  started = false;
  stopped = false;
  interrupted = false;
  transcribed = false;
  synthesized = false;
  played = false;
  runtimeHandedOff = false;
  runtimeHandoffCount = 0;
  lastHandoffParams: VoiceRuntimeHandoffParams | undefined;
  playbackAvailable = true;
  asrAvailable = true;
  ttsAvailable = true;
  readonly vadHandlers = new Set<(event: VoiceVadEvent) => void>();
  readonly turnHandlers = new Set<(event: VoiceTurnEvent) => void>();
  readonly asrPartialHandlers = new Set<
    (event: VoiceAsrPartialEvent) => void
  >();
  readonly asrFinalHandlers = new Set<(event: VoiceAsrFinalEvent) => void>();
  readonly playbackHandlers = new Set<(event: VoicePlaybackEvent) => void>();
  readonly errorHandlers = new Set<(event: VoiceRuntimeErrorEvent) => void>();

  async status(): Promise<VoiceRuntimeStatus> {
    return {
      mode: "local-runtime",
      listening: this.started && !this.stopped,
      asrPartialSupport: true,
      ttsStreamingSupport: false,
      playbackSupport: this.playbackAvailable,
      playbackAckSupport: this.playbackAvailable,
      runtimeDraftSupport: false,
      vadSupport: true,
      turnSupport: true,
    };
  }

  async components(): Promise<VoiceComponentSnapshot[]> {
    return [
      {
        id: "mock-asr",
        name: "Mock ASR",
        role: "asr",
        status: "ready",
      },
    ];
  }

  async startListening(): Promise<VoiceRuntimeStatus> {
    this.started = true;
    return this.status();
  }

  async stopListening(): Promise<VoiceRuntimeStatus> {
    this.stopped = true;
    return this.status();
  }

  async interrupt(): Promise<VoiceRuntimeStatus> {
    this.interrupted = true;
    return this.status();
  }

  onVad(handler: (event: VoiceVadEvent) => void): () => void {
    return this.register(this.vadHandlers, handler);
  }

  onTurn(handler: (event: VoiceTurnEvent) => void): () => void {
    return this.register(this.turnHandlers, handler);
  }

  onAsrPartial(handler: (event: VoiceAsrPartialEvent) => void): () => void {
    return this.register(this.asrPartialHandlers, handler);
  }

  onAsrFinal(handler: (event: VoiceAsrFinalEvent) => void): () => void {
    return this.register(this.asrFinalHandlers, handler);
  }

  onPlayback(handler: (event: VoicePlaybackEvent) => void): () => void {
    return this.register(this.playbackHandlers, handler);
  }

  onError(handler: (event: VoiceRuntimeErrorEvent) => void): () => void {
    return this.register(this.errorHandlers, handler);
  }

  async transcribeAudio(
    params: VoiceTranscribeAudioParams,
  ): Promise<VoiceAsrFinalEvent> {
    if (!this.asrAvailable) {
      throw new VoiceError("VOICE_ASR_UNAVAILABLE", "Mock ASR unavailable.");
    }
    this.transcribed = true;
    return {
      text: params.audioBase64,
      metadata: params.metadata,
    };
  }

  async synthesizeSpeech(
    params: VoiceSynthesizeSpeechParams,
  ): Promise<VoiceSynthesisResult> {
    if (!this.ttsAvailable) {
      throw new VoiceError("VOICE_TTS_UNAVAILABLE", "Mock TTS unavailable.");
    }
    this.synthesized = true;
    return {
      audioBase64: Buffer.from(params.text).toString("base64"),
      mimeType: "audio/wav",
      byteLength: params.text.length,
      provider: "mock",
      voiceId: params.voiceId,
    };
  }

  async playAudio(): Promise<VoicePlaybackEvent> {
    if (!this.playbackAvailable) {
      throw new VoiceError(
        "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
        "Mock playback unavailable.",
      );
    }
    this.played = true;
    return { started: true, metadata: { provider: "mock" } };
  }

  async sendRuntimeMessage(
    params: VoiceRuntimeHandoffParams,
  ): Promise<VoiceRuntimeHandoffResult> {
    this.runtimeHandedOff = true;
    this.runtimeHandoffCount += 1;
    this.lastHandoffParams = params;
    return {
      firstTokenText: "ok",
      responseText: `response:${params.text}`,
      conversationId: "conv-1",
      messageId: "message-1",
    };
  }

  emitVad(event: VoiceVadEvent): void {
    for (const handler of this.vadHandlers) handler(event);
  }

  emitAsrPartial(event: VoiceAsrPartialEvent): void {
    for (const handler of this.asrPartialHandlers) handler(event);
  }

  emitAsrFinal(event: VoiceAsrFinalEvent): void {
    for (const handler of this.asrFinalHandlers) handler(event);
  }

  private register<T>(
    set: Set<(event: T) => void>,
    handler: (event: T) => void,
  ): () => void {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }
}

function flushVoiceEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function harness(env: Record<string, string | undefined> = {}): {
  voice: VoiceService;
  trace: TraceService;
  canvas: FakeCanvas;
  adapter: MockVoiceRuntimeAdapter;
} {
  let tick = 0;
  let traceSession = 0;
  let traceEvent = 0;
  const now = () =>
    new Date(Date.parse("2026-05-17T12:00:00.000Z") + tick++ * 10);
  const registry = new DynamicViewRegistry();
  const canvas = new FakeCanvas();
  const dynamicViewSessions = new DynamicViewSessionManager({
    registry,
    canvas,
    workerStatusProvider: new FakeWorkerStatusProvider(),
    now,
    sessionIdFactory: () => "view-session-1",
  });
  const trace = new TraceService({
    store: new TraceStore({
      now,
      sessionIdFactory: () => `trace-${++traceSession}`,
      eventIdFactory: () => `trace-event-${++traceEvent}`,
    }),
    dynamicViewRegistry: registry,
    dynamicViewSessions,
    env,
  });
  const adapter = new MockVoiceRuntimeAdapter();
  return {
    voice: new VoiceService({
      traceService: trace,
      env,
      now,
      pipelineIdFactory: () => "voice-pipeline-1",
      turnIdFactory: () => `voice-turn-${traceSession + 1}`,
      runtimeAdapter: adapter,
    }),
    trace,
    canvas,
    adapter,
  };
}

describe("VoiceService", () => {
  it("reports static voice component availability", async () => {
    const { voice } = harness();
    const components = await voice.components();
    const ids = components.map((component) => component.id);

    expect(ids).toContain("kokoro");
    expect(ids).toContain("asr");
    expect(ids).toContain("vad");
    expect(ids).toContain("turn-detector");
    expect(
      components.find((component) => component.id === "kokoro"),
    ).toMatchObject({ status: "available", role: "tts" });
  });

  it("runs a mock voice turn and summarizes latency", async () => {
    const { voice } = harness();
    await voice.start({ mode: "mock" });
    const partial = await voice.injectTranscript({ text: "hello" });
    const final = await voice.injectTranscript({
      text: "hello world",
      final: true,
    });
    const spoken = await voice.speak({ text: "response" });
    const latency = await voice.latency();

    expect(partial).toMatchObject({
      status: "asr_partial",
      transcriptPartial: "hello",
    });
    expect(final).toMatchObject({
      status: "model_first_token",
      transcriptFinal: "hello world",
    });
    expect(spoken).toMatchObject({
      status: "completed",
      responseText: "response",
    });
    expect(latency.budgetResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "total_to_playback" }),
      ]),
    );
    expect(latency.totalToFirstAudioMs).toBeGreaterThan(0);
    expect(latency.totalToPlaybackMs).toBeGreaterThan(0);
    await expect(voice.recentTurns()).resolves.toHaveLength(1);
  });

  it("records voice events into trace when requested", async () => {
    const { voice, trace } = harness();
    await voice.start({ trace: true });
    const partial = await voice.injectTranscript({ text: "hi" });
    await voice.injectTranscript({ text: "hi there", final: true });
    await voice.speak({ text: "hello" });

    expect(partial.traceSessionId).toBe("trace-trace-1");
    const events = await trace.searchEvents({ runId: partial.id });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "voice.vad",
        "voice.asr.partial",
        "voice.asr.final",
        "model.request.started",
        "model.first_token",
        "voice.tts.started",
        "voice.tts.first_audio",
        "voice.playback.started",
        "voice.latency.budget",
        "session.completed",
      ]),
    );
  });

  it("keeps trace auto-open off by default and enables it explicitly", async () => {
    const defaultHarness = harness();
    await defaultHarness.voice.start({ trace: true });
    await defaultHarness.voice.injectTranscript({ text: "hi" });
    expect(defaultHarness.canvas.windows).toHaveLength(0);

    const autoHarness = harness({ ELIZA_VOICE_TRACE_AUTO_OPEN: "1" });
    await autoHarness.voice.start();
    await autoHarness.voice.injectTranscript({ text: "hi" });
    expect(autoHarness.canvas.windows).toHaveLength(1);
  });

  it("interrupts running turns and rejects transcript injection while idle", async () => {
    const { voice } = harness();
    await expect(
      voice.injectTranscript({ text: "not running" }),
    ).rejects.toBeInstanceOf(VoiceError);
    await voice.start();
    await voice.injectTranscript({ text: "hello" });
    const snapshot = await voice.interrupt({ reason: "barge-in" });

    expect(snapshot.status).toBe("interrupted");
    expect(snapshot.recentTurns[0]).toMatchObject({
      status: "interrupted",
      error: "barge-in",
    });
  });

  it("keeps live modes disabled unless explicit flags are set", async () => {
    const { voice } = harness();

    await expect(voice.start({ mode: "local-runtime" })).rejects.toMatchObject({
      code: "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
    });
  });

  it("starts local runtime mode and records adapter VAD and ASR events", async () => {
    const { voice, trace, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
    });

    await voice.start({ mode: "local-runtime", trace: true });
    adapter.emitVad({ active: true, score: 0.9 });
    adapter.emitAsrPartial({ text: "hello" });
    adapter.emitAsrFinal({ text: "hello world" });
    await flushVoiceEvents();

    const turn = (await voice.status()).currentTurn;
    expect(adapter.started).toBe(true);
    expect(adapter.runtimeHandedOff).toBe(true);
    expect(turn).toMatchObject({
      transcriptPartial: "hello",
      transcriptFinal: "hello world",
      responseText: "response:hello world",
      status: "model_first_token",
    });

    const events = await trace.searchEvents({ runId: turn?.id });
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "voice.vad",
        "voice.asr.partial",
        "voice.asr.final",
        "model.request.started",
        "model.first_token",
      ]),
    );
  });

  it("does not commit ASR partials to runtime by default", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
    });

    await voice.start({ mode: "local-runtime" });
    adapter.emitAsrPartial({ text: "draft words" });
    await flushVoiceEvents();

    const snapshot = await voice.status();
    expect(adapter.runtimeHandedOff).toBe(false);
    expect(snapshot).toMatchObject({
      partialRuntimeStreamingEnabled: false,
      partialRuntimeStreamingMode: "disabled",
    });
    expect(snapshot.currentTurn).toMatchObject({
      transcriptPartial: "draft words",
      status: "asr_partial",
    });
  });

  it("marks ASR partial prepare-only mode without calling conversation routes", async () => {
    const { voice, trace, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
      ELIZA_VOICE_STREAM_ASR_PARTIALS: "1",
    });

    await voice.start({ mode: "local-runtime", trace: true });
    adapter.emitAsrPartial({ text: "draft words" });
    await flushVoiceEvents();

    const snapshot = await voice.status();
    expect(adapter.runtimeHandedOff).toBe(false);
    expect(snapshot).toMatchObject({
      partialRuntimeStreamingEnabled: true,
      partialRuntimeStreamingSupported: false,
      partialRuntimeStreamingMode: "prepare-only",
    });
    const events = await trace.searchEvents({
      runId: snapshot.currentTurn?.id,
    });
    expect(events.map((event) => event.kind)).toContain(
      "model.prepare.skipped",
    );
  });

  it("commits the ASR final to runtime once", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
    });

    await voice.start({ mode: "local-runtime" });
    adapter.emitAsrFinal({ text: "hello world" });
    adapter.emitAsrFinal({ text: "hello world" });
    await flushVoiceEvents();

    expect(adapter.runtimeHandoffCount).toBe(1);
  });

  it("hands the final transcript off as VOICE_DM with a COMPUTED turn signal (#8786)", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
    });

    await voice.start({ mode: "local-runtime" });
    adapter.emitAsrFinal({ text: "what is on my calendar today" });
    await flushVoiceEvents();

    expect(adapter.runtimeHandedOff).toBe(true);
    // The signal must be COMPUTED by voice-service from the transcript — not
    // injected by the caller — so the server voice gate
    // (core.voice_turn_signal / _confirm) actually has something to read on
    // desktop. Before #8786 this path sent a bare { text } and the gate was inert.
    const signal = adapter.lastHandoffParams?.metadata?.voiceTurnSignal as
      | Record<string, unknown>
      | undefined;
    expect(signal).toBeDefined();
    expect(typeof signal?.endOfTurnProbability).toBe("number");
    expect(signal?.agentShouldSpeak).toBe(true);
    expect(["agent", "user", "unknown"]).toContain(signal?.nextSpeaker);
    expect(String(signal?.source)).toMatch(/^client-ambient/);
  });

  it("suppresses the agent's own echo while TTS playback is within the post-TTS cooldown (#12256 layer 1)", async () => {
    // A controllable clock so the reply's age can exceed ECHO_WINDOW_MS (9 s)
    // while playback stays recent — the case the age-only guard misses and the
    // playback-cooldown catches.
    let clockMs = Date.parse("2026-05-17T12:00:00.000Z");
    const adapter = new MockVoiceRuntimeAdapter();
    const voice = new VoiceService({
      env: {
        ELIZA_VOICE_LIVE_RUNTIME: "1",
        ELIZA_VOICE_POST_TTS_COOLDOWN_MS: "1500",
      },
      now: () => new Date(clockMs),
      runtimeAdapter: adapter,
    });
    await voice.start({ mode: "local-runtime" });

    // Turn 1: the agent replies, so lastAgentReply = "response:the capital…".
    adapter.emitAsrFinal({ text: "the capital of france" });
    await flushVoiceEvents();

    // A long reply plays for 12 s — its message age now exceeds ECHO_WINDOW_MS,
    // so the age-only echo guard would MISS a late echo. The playback stamp is
    // fresh (this is what the cooldown catches). The mock reply text is
    // "response:the capital of france"; the echo transcribes the clean tail.
    clockMs += 12_000;
    await voice.synthesizeSpeech({ text: "the capital of france" });
    clockMs += 500; // echo returns 500 ms into playback (inside the 1500 cooldown)

    adapter.emitAsrFinal({ text: "capital of france" });
    await flushVoiceEvents();
    const signalDuring = adapter.lastHandoffParams?.metadata?.voiceTurnSignal as
      | Record<string, unknown>
      | undefined;
    expect(signalDuring?.agentShouldSpeak).toBe(false); // echo suppressed
    expect(signalDuring?.nextSpeaker).toBe("user");

    // Close the echo turn with a playback so the next ASR-final opens a fresh
    // turn (an unfinished turn would short-circuit on runtimeCommitTurnId).
    await voice.synthesizeSpeech({ text: "anything else" });

    // Well past the cooldown AND the age window: the same words now read as a
    // genuine (repeated) user turn — the gate no longer suppresses on echo.
    clockMs += 12_000;
    adapter.emitAsrFinal({ text: "capital of france" });
    await flushVoiceEvents();
    const signalAfter = adapter.lastHandoffParams?.metadata?.voiceTurnSignal as
      | Record<string, unknown>
      | undefined;
    expect(signalAfter?.agentShouldSpeak).toBe(true);
  });

  it("starts live audio mode with a mocked adapter", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_AUDIO: "1",
    });

    const snapshot = await voice.start({ mode: "live-audio" });

    expect(snapshot.status).toBe("listening");
    expect(adapter.started).toBe(true);
  });

  it("transcribes audio through the live adapter and triggers runtime handoff", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
      ELIZA_VOICE_LIVE_ASR: "1",
    });

    await voice.start({ mode: "local-runtime" });
    const turn = await voice.transcribeAudio({
      audioBase64: "audio transcript",
    });

    expect(adapter.transcribed).toBe(true);
    expect(adapter.runtimeHandedOff).toBe(true);
    expect(turn).toMatchObject({
      transcriptFinal: "audio transcript",
      status: "model_first_token",
    });
  });

  it("synthesizes speech and records playback when the adapter supports it", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
      ELIZA_VOICE_LIVE_TTS: "1",
    });

    await voice.start({ mode: "local-runtime" });
    const result = await voice.synthesizeSpeech({
      text: "hello",
      voiceId: "kokoro",
    });

    expect(result).toMatchObject({
      mimeType: "audio/wav",
      provider: "mock",
      voiceId: "kokoro",
    });
    expect(adapter.synthesized).toBe(true);
    expect(adapter.played).toBe(true);
    await expect(voice.recentTurns()).resolves.toMatchObject([
      {
        responseText: "hello",
        status: "completed",
      },
    ]);
  });

  it("returns structured errors for missing ASR, TTS, and playback", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
      ELIZA_VOICE_LIVE_ASR: "1",
      ELIZA_VOICE_LIVE_TTS: "1",
    });

    await voice.start({ mode: "local-runtime" });
    adapter.asrAvailable = false;
    await expect(
      voice.transcribeAudio({ audioBase64: "audio" }),
    ).rejects.toMatchObject({ code: "VOICE_ASR_UNAVAILABLE" });

    adapter.asrAvailable = true;
    adapter.ttsAvailable = false;
    await expect(
      voice.synthesizeSpeech({ text: "hello" }),
    ).rejects.toMatchObject({ code: "VOICE_TTS_UNAVAILABLE" });

    adapter.ttsAvailable = true;
    adapter.playbackAvailable = false;
    await expect(
      voice.synthesizeSpeech({ text: "hello" }),
    ).rejects.toMatchObject({ code: "VOICE_AUDIO_OUTPUT_UNAVAILABLE" });
  });

  it("stops live mode and removes adapter subscriptions", async () => {
    const { voice, adapter } = harness({
      ELIZA_VOICE_LIVE_RUNTIME: "1",
    });

    await voice.start({ mode: "local-runtime" });
    await voice.stop({ reason: "done" });

    expect(adapter.stopped).toBe(true);
    expect(adapter.vadHandlers.size).toBe(0);
    expect(adapter.asrPartialHandlers.size).toBe(0);
    expect(adapter.asrFinalHandlers.size).toBe(0);
  });
});
