/**
 * `VoiceTurnController` tests — turn-taking above the scheduler.
 *
 * Drives the controller with a hand-cranked fake `VadEvent` stream + a fake
 * `StreamingTranscriber` and asserts the brief's A4/A5 contract:
 *   - speech-start → `prewarm()` fires
 *   - speech-pause(ms ≥ threshold) → a SPECULATIVE generate kicks off the
 *     current partial transcript with an `AbortSignal`
 *   - speech-active again → the speculative generate is ABORTED
 *   - speech-end + matching final transcript → the speculative is PROMOTED
 *   - speech-end + diverged final transcript → speculative discarded, a
 *     fresh FINAL generate runs
 *   - the transcriber's `words` event → `bargeIn.onWordsDetected`
 *     (provisional `pause-tts` → `hard-stop`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubOmniVoiceBackend } from "./engine-bridge";
import { InMemoryAudioSink } from "./ring-buffer";
import { VoiceScheduler } from "./scheduler";
import {
  type VoiceGenerateRequest,
  VoiceTurnController,
  type VoiceTurnOutcome,
} from "./turn-controller";
import type {
  SpeakerPreset,
  StreamingTranscriber,
  TranscriberEvent,
  TranscriberEventListener,
  TranscriptUpdate,
  VadEvent,
  VadEventListener,
} from "./types";

function makePreset(): SpeakerPreset {
  const embedding = new Float32Array([0.1, 0.2, 0.3]);
  return {
    voiceId: "default",
    embedding,
    bytes: new Uint8Array(embedding.buffer.slice(0)),
  };
}

function makeScheduler(): VoiceScheduler {
  return new VoiceScheduler(
    {
      chunkerConfig: { maxTokensPerPhrase: 30 },
      preset: makePreset(),
      ringBufferCapacity: 4096,
      sampleRate: 24000,
    },
    { backend: new StubOmniVoiceBackend(24000), sink: new InMemoryAudioSink() },
  );
}

class FakeVad {
  private readonly listeners = new Set<VadEventListener>();
  onVadEvent(listener: VadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: VadEvent): void {
    for (const l of this.listeners) l(event);
  }
}

class FakeTranscriber implements StreamingTranscriber {
  private readonly listeners = new Set<TranscriberEventListener>();
  partial = "";
  finalText = "";
  flushCalls = 0;
  feed(): void {}
  async flush(): Promise<TranscriptUpdate> {
    this.flushCalls++;
    return { partial: this.finalText, isFinal: true };
  }
  on(listener: TranscriberEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {}
  emit(event: TranscriberEvent): void {
    for (const l of this.listeners) l(event);
  }
  setPartial(text: string): void {
    this.partial = text;
    this.emit({ kind: "partial", update: { partial: text, isFinal: false } });
  }
}

let ts = 0;
function vadEvent(
  event: Partial<VadEvent> & { type: VadEvent["type"] },
): VadEvent {
  ts += 100;
  switch (event.type) {
    case "speech-start":
      return { type: "speech-start", timestampMs: ts, probability: 0.9 };
    case "speech-active":
      return {
        type: "speech-active",
        timestampMs: ts,
        probability: 0.9,
        speechDurationMs: 500,
      };
    case "speech-pause":
      return {
        type: "speech-pause",
        timestampMs: ts,
        pauseDurationMs:
          (event as { pauseDurationMs?: number }).pauseDurationMs ?? 400,
      };
    case "speech-end":
      return { type: "speech-end", timestampMs: ts, speechDurationMs: 1000 };
    case "blip":
      return { type: "blip", timestampMs: ts, durationMs: 30, peakRms: 0.2 };
  }
}

interface Harness {
  vad: FakeVad;
  transcriber: FakeTranscriber;
  scheduler: VoiceScheduler;
  controller: VoiceTurnController;
  prewarm: ReturnType<typeof vi.fn>;
  generateCalls: VoiceGenerateRequest[];
  /** Resolve the n-th pending generate (0-based) with the given reply. */
  resolveGenerate(index: number, replyText: string): void;
  events: {
    speculativeStart: string[];
    speculativeAbort: number;
    speculativePromoted: VoiceTurnOutcome[];
    turnComplete: VoiceTurnOutcome[];
    errors: Error[];
  };
}

function makeHarness(opts: { speculatePauseMs?: number } = {}): Harness {
  const vad = new FakeVad();
  const transcriber = new FakeTranscriber();
  const scheduler = makeScheduler();
  const prewarm = vi.fn(async () => {});
  const generateCalls: VoiceGenerateRequest[] = [];
  const pending: Array<(o: VoiceTurnOutcome) => void> = [];
  const events: Harness["events"] = {
    speculativeStart: [],
    speculativeAbort: 0,
    speculativePromoted: [],
    turnComplete: [],
    errors: [],
  };
  const controller = new VoiceTurnController(
    {
      vad,
      transcriber,
      scheduler,
      prewarm,
      generate: (request) => {
        generateCalls.push(request);
        return new Promise<VoiceTurnOutcome>((resolve, reject) => {
          // Reject if the request is aborted before it's resolved.
          request.signal.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
          pending.push((o) => resolve(o));
        });
      },
    },
    {
      roomId: "room-1",
      ...(opts.speculatePauseMs !== undefined
        ? { speculatePauseMs: opts.speculatePauseMs }
        : {}),
    },
    {
      onSpeculativeStart: (t) => events.speculativeStart.push(t),
      onSpeculativeAbort: () => {
        events.speculativeAbort++;
      },
      onSpeculativePromoted: (o) => events.speculativePromoted.push(o),
      onTurnComplete: (o) => events.turnComplete.push(o),
      onError: (e) => events.errors.push(e),
    },
  );
  return {
    vad,
    transcriber,
    scheduler,
    controller,
    prewarm,
    generateCalls,
    resolveGenerate(index, replyText) {
      const transcript = generateCalls[index]?.transcript ?? "";
      pending[index]?.({ transcript, replyText });
    },
    events,
  };
}

describe("VoiceTurnController", () => {
  beforeEach(() => {
    ts = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires prewarm on speech-start, before STT finishes", () => {
    const h = makeHarness();
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    expect(h.prewarm).toHaveBeenCalledWith("room-1");
  });

  it("kicks a speculative generate on a long-enough speech-pause", () => {
    const h = makeHarness({ speculatePauseMs: 300 });
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("turn on the lights");
    // Too-short pause — no speculation.
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 200 }));
    expect(h.generateCalls).toHaveLength(0);
    // Long-enough pause — speculation kicks off the current partial.
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 400 }));
    expect(h.generateCalls).toHaveLength(1);
    expect(h.generateCalls[0]).toMatchObject({
      transcript: "turn on the lights",
      final: false,
    });
    expect(h.events.speculativeStart).toEqual(["turn on the lights"]);
  });

  it("aborts the speculative generate when speech resumes (speech-active)", () => {
    const h = makeHarness({ speculatePauseMs: 300 });
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("what is");
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 400 }));
    expect(h.generateCalls).toHaveLength(1);
    expect(h.generateCalls[0].signal.aborted).toBe(false);
    h.vad.emit(vadEvent({ type: "speech-active" }));
    expect(h.generateCalls[0].signal.aborted).toBe(true);
    expect(h.events.speculativeAbort).toBe(1);
  });

  it("promotes the speculative result on speech-end when it matches the final transcript", async () => {
    const h = makeHarness({ speculatePauseMs: 300 });
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("hello there");
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 400 }));
    expect(h.generateCalls).toHaveLength(1);
    // The speculative produces a reply...
    h.resolveGenerate(0, "Hi! How can I help?");
    // ...and the segment ends with the SAME transcript the speculation used.
    h.transcriber.finalText = "hello there";
    h.vad.emit(vadEvent({ type: "speech-end" }));
    // Let the finalize promise (flush + await speculative) settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(h.transcriber.flushCalls).toBe(1);
    // No second generate — the speculative was promoted.
    expect(h.generateCalls).toHaveLength(1);
    expect(h.events.speculativePromoted).toHaveLength(1);
    expect(h.events.speculativePromoted[0].replyText).toBe(
      "Hi! How can I help?",
    );
    expect(h.events.turnComplete).toHaveLength(1);
  });

  it("discards a stale speculative and runs a fresh final turn when the transcript diverged", async () => {
    const h = makeHarness({ speculatePauseMs: 300 });
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("turn on");
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 400 }));
    expect(h.generateCalls).toHaveLength(1);
    h.resolveGenerate(0, "(speculative reply)");
    // The full utterance was actually longer.
    h.transcriber.finalText = "turn on the kitchen lights";
    h.vad.emit(vadEvent({ type: "speech-end" }));
    await new Promise((r) => setTimeout(r, 0));
    // The speculative was aborted/discarded; a fresh FINAL generate ran on
    // the finalized transcript.
    expect(h.generateCalls).toHaveLength(2);
    expect(h.generateCalls[1]).toMatchObject({
      transcript: "turn on the kitchen lights",
      final: true,
    });
    h.resolveGenerate(1, "Turning on the kitchen lights.");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.events.speculativeAbort).toBe(1);
    expect(h.events.speculativePromoted).toHaveLength(0);
    expect(h.events.turnComplete).toHaveLength(1);
    expect(h.events.turnComplete[0].replyText).toBe(
      "Turning on the kitchen lights.",
    );
  });

  it("runs a final turn directly when no speculation happened", async () => {
    const h = makeHarness();
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("");
    h.transcriber.finalText = "good morning";
    h.vad.emit(vadEvent({ type: "speech-end" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.generateCalls).toHaveLength(1);
    expect(h.generateCalls[0]).toMatchObject({
      transcript: "good morning",
      final: true,
    });
  });

  it("a new speech-start aborts an in-flight speculative (VAD re-trigger)", () => {
    const h = makeHarness({ speculatePauseMs: 300 });
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    h.transcriber.setPartial("hey");
    h.vad.emit(vadEvent({ type: "speech-pause", pauseDurationMs: 400 }));
    expect(h.generateCalls).toHaveLength(1);
    // A brand-new utterance onset before the segment ended.
    h.vad.emit(vadEvent({ type: "speech-start" }));
    expect(h.generateCalls[0].signal.aborted).toBe(true);
    expect(h.prewarm).toHaveBeenCalledTimes(2);
  });

  it("routes the transcriber 'words' event into the barge-in word-confirm gate", () => {
    const h = makeHarness();
    h.controller.start();
    // Simulate the agent speaking + a provisional barge-in.
    h.scheduler.bargeIn.setAgentSpeaking(true);
    let hardStopped = false;
    h.scheduler.bargeIn.onSignal((s) => {
      if (s.type === "hard-stop") hardStopped = true;
    });
    // A blip alone (no words) only pauses — emit a pause-style provisional.
    h.scheduler.bargeIn.onSignal(() => {});
    h.vad.emit(vadEvent({ type: "speech-active" })); // → pause-tts
    expect(hardStopped).toBe(false);
    // ASR confirms real words → hard-stop.
    h.transcriber.emit({ kind: "words", words: ["wait", "stop"] });
    expect(hardStopped).toBe(true);
  });

  it("surfaces a prewarm rejection via onError without killing the turn", async () => {
    const h = makeHarness();
    h.prewarm.mockRejectedValueOnce(new Error("kv prefill failed"));
    h.controller.start();
    h.vad.emit(vadEvent({ type: "speech-start" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.events.errors.map((e) => e.message)).toContain(
      "kv prefill failed",
    );
    // Turn-taking still works.
    h.transcriber.finalText = "ok";
    h.vad.emit(vadEvent({ type: "speech-end" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.generateCalls).toHaveLength(1);
  });
});
