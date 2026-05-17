import type { JsonValue } from "@elizaos/electrobun-carrots";
import { describe, expect, it } from "vitest";
import { DynamicViewRegistry } from "../dynamic-views/registry";
import { DynamicViewSessionManager } from "../dynamic-views/session-manager";
import { TraceService } from "../trace/trace-service";
import { TraceStore } from "../trace/trace-store";
import { VoiceError } from "./errors";
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

function harness(env: Record<string, string | undefined> = {}): {
  voice: VoiceService;
  trace: TraceService;
  canvas: FakeCanvas;
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
  return {
    voice: new VoiceService({
      traceService: trace,
      env,
      now,
      pipelineIdFactory: () => "voice-pipeline-1",
      turnIdFactory: () => `voice-turn-${traceSession + 1}`,
    }),
    trace,
    canvas,
  };
}

describe("VoiceService", () => {
  it("reports static voice component availability", async () => {
    const { voice } = harness();
    const components = await voice.components();
    const ids = components.map((component) => component.id);

    expect(ids).toContain("omnivoice");
    expect(ids).toContain("kokoro");
    expect(ids).toContain("asr");
    expect(ids).toContain("vad");
    expect(ids).toContain("turn-detector");
    expect(
      components.find((component) => component.id === "omnivoice"),
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
});
