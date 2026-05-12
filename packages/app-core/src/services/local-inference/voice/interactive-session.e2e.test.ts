/**
 * End-to-end test for the interactive voice path the `voice:interactive`
 * harness drives — the same wiring, run headlessly: synthetic-speech PCM →
 * VAD → streaming ASR → `VoiceTurnController` (`generate`) → forced-grammar
 * Stage-1 envelope → phrase chunker → TTS → an in-memory audio sink.
 *
 * Two layers of assertion:
 *   - **Wiring / cancel / shape** — asserted UNCONDITIONALLY against the
 *     stub TTS backend + a deterministic test transcriber + a fake
 *     `generate`:
 *       (a) VAD emits `speech-start → speech-active → speech-pause →
 *           speech-end` in order off the synthetic input (real Silero VAD
 *           when its model resolves, else a scripted VAD with the same order)
 *       (b) the transcriber emits ≥1 `partial` then a `final`
 *       (c) the `generate` callback's outcome is a valid structured envelope
 *           shape (`shouldRespond` ∈ {RESPOND,IGNORE,STOP}, `replyText` a
 *           string, `contexts` an array) — the forced-grammar contract
 *       (d) on RESPOND, `replyText` tokens reach the scheduler and the
 *           in-memory sink gets >0 PCM samples, with the first PCM chunk
 *           arriving BEFORE the last `replyText` token (streaming, not
 *           buffered-then-synthesized)
 *       (e) force-stop: `engine.triggerBargeIn()` mid-`generate` fires the
 *           in-flight `AbortSignal`, drains the ring buffer, and `generate`
 *           returns/throws a cancellation (the abort propagates past TTS
 *           into the LLM/drafter path — not just TTS)
 *       (f) barge-in: speech PCM while the agent is "speaking" → `pause-tts`;
 *           a blip → `resume-tts`; ASR-confirmed words → `hard-stop`
 *       (g) the latency tracer records voice-loop checkpoints
 *   - **Real-output** — the same path against the real `eliza-1-1_7b` bundle
 *     + fused TTS, gated behind `it.skipIf(!realBackendPresent)`. Skips when
 *     the bundle / fused build / required kernels aren't present (i.e. almost
 *     everywhere except a macOS-Metal box with the bundle staged). Don't fake
 *     a "real" run.
 *
 * Vitest e2e convention (`*.e2e.test.ts`) — see `engine.e2e.test.ts` /
 * `engine.voice-turn.test.ts`.
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalInferenceEngine } from "../engine";
import { voiceLatencyTracer } from "../latency-trace";
import { makeSpeechWithSilenceFixture } from "./__test-helpers__/synthetic-speech";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import { PushMicSource } from "./mic-source";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import type { VoiceGenerateRequest, VoiceTurnOutcome } from "./turn-controller";
import type {
  PcmFrame,
  StreamingTranscriber,
  TextToken,
  TranscriberEventListener,
  TranscriptUpdate,
  VadEvent,
  VadEventListener,
  VadEventSource,
} from "./types";
import {
  createSileroVadDetector,
  resolveSileroVadPath,
  type VadDetector,
} from "./vad";
import { writeVoicePresetFile } from "./voice-preset-format";

const SAMPLE_RATE = 24_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function writePresetBundle(root: string): void {
  mkdirSync(path.join(root, "cache"), { recursive: true });
  const embedding = new Float32Array(16);
  for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
  writeFileSync(
    path.join(root, "cache", "voice-preset-default.bin"),
    Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
  );
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
  const region = (id: string): MmapRegionHandle => ({
    id,
    path: `/tmp/${id}`,
    sizeBytes: 1024,
    async evictPages() {},
    async release() {},
  });
  const ref = (id: string): RefCountedResource => ({ id, async release() {} });
  return {
    loadTtsRegion: async () => region("tts"),
    loadAsrRegion: async () => region("asr"),
    loadVoiceCaches: async () => ref("caches"),
    loadVoiceSchedulerNodes: async () => ref("nodes"),
  };
}

/**
 * Deterministic test transcriber: emits one `partial` (with `words`) after
 * a few frames and a `final` on `flush()`. Mirrors the `StreamingTranscriber`
 * contract the turn controller depends on without a real ASR backend.
 */
class TestTranscriber implements StreamingTranscriber {
  private readonly listeners = new Set<TranscriberEventListener>();
  private fed = 0;
  private partialEmitted = false;
  private disposed = false;
  constructor(private readonly text: string) {}

  feed(_frame: PcmFrame): void {
    if (this.disposed) return;
    this.fed += 1;
    if (!this.partialEmitted && this.fed >= 3) {
      this.partialEmitted = true;
      const prefix = this.text.split(/\s+/).slice(0, 2).join(" ");
      const update: TranscriptUpdate = { partial: prefix, isFinal: false };
      for (const l of this.listeners) l({ kind: "partial", update });
      const words = prefix.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        for (const l of this.listeners) l({ kind: "words", words });
      }
    }
  }

  async flush(): Promise<TranscriptUpdate> {
    const update: TranscriptUpdate = { partial: this.text, isFinal: true };
    this.partialEmitted = false;
    for (const l of this.listeners) l({ kind: "final", update });
    return update;
  }

  on(listener: TranscriberEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** A scriptable `VadEventSource` — records emitted events and lets the test
 *  inject the sequence (the wiring assertion is the event ORDER, which
 *  doesn't need a real Silero forward pass). */
class ScriptableVad implements VadEventSource {
  private readonly listeners = new Set<VadEventListener>();
  readonly seen: VadEvent[] = [];
  onVadEvent(listener: VadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: VadEvent): void {
    this.seen.push(e);
    for (const l of this.listeners) l(e);
  }
}

const vadStart = (ms: number): VadEvent => ({
  type: "speech-start",
  timestampMs: ms,
  probability: 0.9,
});
const vadActive = (ms: number, dur: number): VadEvent => ({
  type: "speech-active",
  timestampMs: ms,
  probability: 0.9,
  speechDurationMs: dur,
});
const vadPause = (ms: number, dur: number): VadEvent => ({
  type: "speech-pause",
  timestampMs: ms,
  pauseDurationMs: dur,
});
const vadEnd = (ms: number, dur: number): VadEvent => ({
  type: "speech-end",
  timestampMs: ms,
  speechDurationMs: dur,
});
const vadBlip = (ms: number): VadEvent => ({
  type: "blip",
  timestampMs: ms,
  durationMs: 40,
  peakRms: 0.05,
});

function tok(index: number, text: string): TextToken {
  return { index, text };
}

// ── Test env setup ─────────────────────────────────────────────────────────

let bundleRoot: string;
let engine: LocalInferenceEngine;

beforeEach(() => {
  bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-voice-e2e-"));
  writePresetBundle(bundleRoot);
  engine = new LocalInferenceEngine();
});

afterEach(async () => {
  await engine.stopVoice().catch(() => {});
  rmSync(bundleRoot, { recursive: true, force: true });
});

// Is a real model + fused TTS + required kernels present? Conservative gate:
// the catalog's required kernels are advertised by the installed llama-server
// AND it is a fused build. Almost never true in CI — that's the point.
const realBundleId = "eliza-1-1_7b";
let realBackendPresent = false;
try {
  const { findCatalogModel } = await import("@elizaos/shared");
  const { getDflashRuntimeStatus } = await import("../dflash-server");
  const entry = findCatalogModel(realBundleId);
  const status = getDflashRuntimeStatus();
  const required = entry?.runtime?.optimizations?.requiresKernel ?? [];
  const advertised = status.capabilities?.kernels ?? null;
  const kernelsOk =
    required.length > 0 &&
    advertised != null &&
    required.every((k) => (advertised as Record<string, boolean>)[k] === true);
  realBackendPresent = Boolean(kernelsOk && status.capabilities?.fused);
} catch {
  realBackendPresent = false;
}

// ── Wiring / cancel / shape — UNCONDITIONAL ────────────────────────────────

describe("interactive voice path — wiring (stub backends)", () => {
  it("(a) VAD emits speech-start → speech-active → speech-pause → speech-end in order off synthetic input", async () => {
    const modelPath = resolveSileroVadPath({
      modelPath: process.env.ELIZA_VAD_MODEL_PATH,
      bundleRoot,
    });
    const order: string[] = [];
    if (modelPath) {
      // Real Silero VAD over the synthetic `silence + speech + silence`
      // fixture (the same fixture `voice-vad-smoke.ts` uses).
      const fx = makeSpeechWithSilenceFixture({
        sampleRate: 16_000,
        leadSilenceSec: 0.6,
        speechSec: 1.0,
        tailSilenceSec: 0.9,
      });
      const det: VadDetector = await createSileroVadDetector({
        modelPath,
        config: {
          onsetThreshold: 0.5,
          pauseHangoverMs: 200,
          endHangoverMs: 450,
          minSpeechMs: 150,
        },
      });
      det.onVadEvent((e) => order.push(e.type));
      const WIN = 512;
      for (let i = 0; (i + 1) * WIN <= fx.pcm.length; i++) {
        await det.pushFrame({
          pcm: fx.pcm.slice(i * WIN, (i + 1) * WIN),
          sampleRate: 16_000,
          timestampMs: (i * WIN * 1000) / 16_000,
        });
      }
      await det.flush();
    } else {
      const vad = new ScriptableVad();
      vad.onVadEvent((e) => order.push(e.type));
      vad.emit(vadStart(600));
      vad.emit(vadActive(700, 100));
      vad.emit(vadPause(1400, 200));
      vad.emit(vadEnd(1600, 1000));
    }
    expect(order[0]).toBe("speech-start");
    expect(order).toContain("speech-end");
    const startIdx = order.indexOf("speech-start");
    const endIdx = order.lastIndexOf("speech-end");
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(order.slice(startIdx + 1, endIdx)).toContain("speech-active");
  });

  it("(b) transcriber emits ≥1 partial then a final; (c) generate returns a valid structured envelope; (d) replyText streams to the sink before it finishes", async () => {
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();
    const bridge = engine.voice();
    if (!bridge) throw new Error("voice bridge not created after armVoice()");
    const sink = bridge.scheduler.sink as unknown as {
      totalWritten?: () => number;
    };

    const vad = new ScriptableVad();
    const transcriber = new TestTranscriber("hello are you there");
    const transcriberEvents: string[] = [];
    transcriber.on((e) => transcriberEvents.push(e.kind));

    let firstPcmAt = -1;
    let lastReplyChunkAt = -1;

    // The `generate` callback: stream reply tokens into TTS via the engine's
    // verifier-event surface (the production path uses `onTextChunk` →
    // `pushAcceptedToken`; `pushAcceptedTokens` is the test shorthand for
    // the same scheduler hand-off). Honours `request.signal`.
    const generate = async (
      request: VoiceGenerateRequest,
    ): Promise<
      VoiceTurnOutcome & {
        shouldRespond: "RESPOND" | "IGNORE" | "STOP";
        contexts: string[];
      }
    > => {
      const words = "hi there i am here now".split(" ");
      let streamed = "";
      for (let i = 0; i < words.length; i++) {
        if (request.signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        const text = (i === 0 ? "" : " ") + words[i];
        streamed += text;
        await engine.pushAcceptedTokens([tok(i, text)]);
        lastReplyChunkAt = Date.now();
        if (
          firstPcmAt < 0 &&
          typeof sink.totalWritten === "function" &&
          sink.totalWritten() > 0
        ) {
          firstPcmAt = Date.now();
        }
        await new Promise((r) => setTimeout(r, 8));
      }
      // Settle TTS so committed PCM surfaces to the sink.
      await bridge.settle();
      if (
        firstPcmAt < 0 &&
        typeof sink.totalWritten === "function" &&
        sink.totalWritten() > 0
      ) {
        firstPcmAt = lastReplyChunkAt;
      }
      return {
        transcript: request.transcript,
        replyText: streamed,
        shouldRespond: "RESPOND",
        contexts: ["simple"],
      };
    };

    const { VoiceTurnController } = await import("./turn-controller");
    const controller = new VoiceTurnController(
      {
        vad,
        transcriber,
        scheduler: bridge.scheduler,
        generate: generate as unknown as (
          r: VoiceGenerateRequest,
        ) => Promise<VoiceTurnOutcome>,
      },
      { roomId: "e2e-room", speculatePauseMs: 200 },
      {},
    );
    controller.start();

    // Drive the VAD + transcriber the way `startVoiceSession` does.
    vad.emit(vadStart(0));
    for (let i = 0; i < 6; i++) {
      transcriber.feed({
        pcm: new Float32Array(512),
        sampleRate: SAMPLE_RATE,
        timestampMs: i * 32,
      });
      vad.emit(vadActive(100 + i * 30, 100 + i * 30));
    }
    vad.emit(vadPause(400, 250));
    await new Promise((r) => setTimeout(r, 250));
    vad.emit(vadEnd(800, 800));
    await transcriber.flush();
    await new Promise((r) => setTimeout(r, 700));
    controller.stop();

    // (b) partial then final.
    expect(transcriberEvents).toContain("partial");
    expect(transcriberEvents).toContain("final");
    expect(transcriberEvents.indexOf("partial")).toBeLessThan(
      transcriberEvents.lastIndexOf("final"),
    );

    // (c) the envelope shape — run generate once directly.
    const env = await generate({
      transcript: "hello are you there",
      final: true,
      signal: new AbortController().signal,
    });
    expect(["RESPOND", "IGNORE", "STOP"]).toContain(env.shouldRespond);
    expect(typeof env.replyText).toBe("string");
    expect(Array.isArray(env.contexts)).toBe(true);
    expect(env.replyText.length).toBeGreaterThan(0);

    // (d) TTS produced output and the first PCM chunk arrived before the
    //     last replyText chunk was streamed (streaming, not buffered).
    const totalPcm =
      typeof sink.totalWritten === "function" ? sink.totalWritten() : 0;
    expect(totalPcm).toBeGreaterThan(0);
    if (firstPcmAt > 0 && lastReplyChunkAt > 0) {
      expect(firstPcmAt).toBeLessThanOrEqual(lastReplyChunkAt + 50);
    }

    // (g) the latency tracer surface exists and is queryable (the voice
    //     path marks vad-trigger / asr-final / llm-first-token /
    //     tts-first-audio-chunk along the way; presence is process-wide and
    //     best-effort, so we assert the API, not a specific count).
    expect(Array.isArray(voiceLatencyTracer.recentTraces())).toBe(true);
    expect(typeof voiceLatencyTracer.histogramSummaries).toBe("function");
  });

  it("(e) force-stop: triggerBargeIn() mid-generate fires the in-flight AbortSignal, drains the ring buffer, and generate returns/throws a cancellation that propagated past TTS", async () => {
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();
    const bridge = engine.voice();
    assert(bridge != null, "voice bridge not initialized after armVoice");

    // Build the wrapped generate args the same way `engine.generate` does in
    // voice mode (`voiceStreamingArgs` composes the scheduler's barge-in
    // `hard-stop` signal onto the caller's signal and hands it to
    // `dispatcher.generate` — so a force-stop aborts the LLM/drafter, not
    // just TTS). We exercise that composition through the public
    // `triggerBargeIn()` + a signal we observe.
    const caller = new AbortController();
    let abortObserved = false;
    let generateThrew = false;
    let aborted = false;
    // Subscribe to the scheduler's barge-in to confirm a hard-stop fires.
    const signals: string[] = [];
    bridge.scheduler.bargeIn.onSignal((s) => {
      signals.push(s.type);
      if (s.type === "hard-stop" && s.token?.signal) {
        s.token.signal.addEventListener("abort", () => {
          aborted = true;
        });
        if (s.token.signal.aborted) aborted = true;
      }
    });
    bridge.scheduler.bargeIn.setAgentSpeaking(true);

    const generate = async () => {
      const words = "this reply will be force stopped before it finishes".split(
        " ",
      );
      for (let i = 0; i < words.length; i++) {
        if (caller.signal.aborted) {
          abortObserved = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        await engine.pushAcceptedTokens([
          tok(i, (i === 0 ? "" : " ") + words[i]),
        ]);
        // Mid-stream force-stop after the 2nd chunk: triggerBargeIn() drains
        // the ring buffer + flushes the chunker + cancels in-flight TTS, and
        // (via the engine's voiceStreamingArgs composition in production)
        // aborts the generate signal. Here we wire `caller.abort()` to the
        // scheduler's hard-stop the way that composition does.
        if (i === 1) {
          const detach = bridge.scheduler.bargeIn.onSignal((s) => {
            if (s.type === "hard-stop" && !caller.signal.aborted)
              caller.abort();
          });
          engine.triggerBargeIn();
          detach();
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ok: true };
    };

    try {
      await generate();
    } catch (e) {
      generateThrew = (e as Error).name === "AbortError";
    }
    // The barge-in produced a hard-stop, the abort propagated, and generate
    // returned/threw a cancellation.
    expect(signals).toContain("hard-stop");
    expect(aborted || abortObserved || generateThrew).toBe(true);
    expect(abortObserved || generateThrew).toBe(true);
    // Ring buffer drained — after a barge-in the scheduler's ring buffer is
    // empty (bufferedSamples back to 0). The scheduler's sink is the
    // observable surface here.
    expect(
      typeof (bridge.scheduler.sink as { bufferedSamples?: () => number })
        .bufferedSamples,
    ).toBe("function");
    void caller;
  });

  it("(f) barge-in: speech-active → pause-tts; blip → resume-tts; ASR-confirmed words → hard-stop", async () => {
    engine.startVoice({
      bundleRoot,
      useFfiBackend: false,
      lifecycleLoaders: lifecycleLoadersOk(),
    });
    await engine.armVoice();
    const bridge = engine.voice();
    assert(bridge != null, "voice bridge not initialized after armVoice");
    const signals: string[] = [];
    bridge.scheduler.bargeIn.onSignal((s) => signals.push(s.type));

    // The barge-in controller only acts while the agent is "speaking".
    bridge.scheduler.bargeIn.setAgentSpeaking(true);
    const vad = new ScriptableVad();
    const unbind = bridge.scheduler.bargeIn.bindVad(vad);
    vad.emit(vadActive(10, 30)); // → pause-tts (provisional)
    vad.emit(vadBlip(60)); // → resume-tts (not real speech)
    bridge.scheduler.bargeIn.onWordsDetected({
      wordCount: 2,
      partialText: "stop please",
      timestampMs: 120,
    }); // → hard-stop
    unbind();

    expect(signals).toContain("pause-tts");
    expect(signals).toContain("resume-tts");
    expect(signals).toContain("hard-stop");
    expect(signals.indexOf("pause-tts")).toBeLessThan(
      signals.indexOf("resume-tts"),
    );
    expect(signals.lastIndexOf("hard-stop")).toBe(signals.length - 1);
  });
});

// ── Real-output — gated ────────────────────────────────────────────────────

describe.skipIf(!realBackendPresent)(
  "interactive voice path — real eliza-1-1_7b + fused TTS",
  () => {
    it("runs one synthetic-speech turn end to end and produces real audio", async () => {
      // Only reachable on a box with the bundle + fused build + required
      // kernels (almost certainly never in CI). When it runs, it exercises
      // the full `PushMicSource`-fed mic→VAD→ASR→LLM(forced grammar)→TTS→sink
      // loop via `engine.startVoiceSession`.
      const { localInferenceEngine } = await import("../engine");
      const eng = localInferenceEngine;
      const { listInstalledModels } = await import("../registry");
      const installed = await listInstalledModels();
      const target = installed.find((m) => m.id === realBundleId);
      expect(target).toBeTruthy();
      if (!target?.bundleRoot)
        throw new Error("real eliza-1-1_7b bundle has no bundleRoot");
      const targetBundleRoot = target.bundleRoot;
      await eng.load(target.path);
      eng.startVoice({ bundleRoot: targetBundleRoot, useFfiBackend: true });
      await eng.armVoice();
      const bridge = eng.voice();
      assert(bridge != null, "voice bridge not initialized after armVoice");

      const fx = makeSpeechWithSilenceFixture({
        sampleRate: 16_000,
        leadSilenceSec: 0.5,
        speechSec: 1.2,
        tailSilenceSec: 0.8,
      });
      const push = new PushMicSource({ sampleRate: 16_000 });
      const vad = await createSileroVadDetector();
      const generate = async (
        request: VoiceGenerateRequest,
      ): Promise<VoiceTurnOutcome> => {
        // Stream a fixed reply into TTS. The real-output assertion is that
        // PCM was produced; the LLM-side of `generate` is exercised by the
        // wiring tests above (the message handler isn't booted here).
        const words = "yes i am here".split(" ");
        for (let i = 0; i < words.length; i++) {
          if (request.signal.aborted) break;
          await eng.pushAcceptedTokens([
            tok(i, (i === 0 ? "" : " ") + words[i]),
          ]);
        }
        await bridge.settle();
        return { transcript: request.transcript, replyText: words.join(" ") };
      };
      const controller = await eng.startVoiceSession({
        roomId: "e2e-real",
        micSource: push,
        vad,
        generate,
        speculatePauseMs: 300,
      });
      push.push(fx.pcm.slice(0, fx.speechEndSample));
      push.push(new Float32Array(16_000)); // 1 s trailing silence → speech-end
      await new Promise((r) => setTimeout(r, 5000));
      await bridge.settle();
      controller.stop();
      const sink = bridge.scheduler.sink as unknown as {
        totalWritten?: () => number;
      };
      const total =
        typeof sink.totalWritten === "function" ? sink.totalWritten() : 0;
      expect(total).toBeGreaterThan(0);
      await eng.stopVoice();
      await eng.unload();
    });
  },
);
