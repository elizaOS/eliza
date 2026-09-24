/**
 * Focused cancellation checks for the one-turn voice RTT harness.
 *
 * The TTS adapters here emit virtual timestamped frames synchronously so the
 * tests can prove active-stream cancellation without adding CI wall time.
 */

import { describe, expect, it } from "vitest";
import { createMockAdapters } from "../src/adapters/mock.ts";
import { loadCorpus } from "../src/corpus.ts";
import { buildReport } from "../src/report.ts";
import { runTurn } from "../src/run-turn.ts";
import type {
  CaseResult,
  CorpusCase,
  TtsAdapter,
  TtsFrame,
} from "../src/types.ts";

describe("runTurn TTS cancellation", () => {
  it("cancels active synthesis when the observed frame clock reaches barge-in", async () => {
    const corpus = bargeInCorpus();
    let emittedFrames = 0;
    const tts = createDeterministicTts({
      frameCount: 32,
      onEmit() {
        emittedFrames++;
      },
    });

    const result = await runBargeTurn(corpus, tts);

    expect(result.trace.cancelled).toBe(true);
    expect(result.trace.postInterruptAudioFrames).toBe(0);
    expect(result.stages.interruptToSilenceMs).toBe(184);
    expect(emittedFrames).toBeLessThan(32);
  });

  it("fails gates when a noncompliant adapter emits frames after playout silence", async () => {
    const corpus = bargeInCorpus();
    const result = await runBargeTurn(
      corpus,
      createDeterministicTts({ frameCount: 40, ignoreCancellation: true }),
    );
    const report = reportFor([result]);

    expect(result.trace.cancelled).toBe(true);
    expect(result.trace.postInterruptAudioFrames).toBeGreaterThan(0);
    expect(report.gates.passed).toBe(false);
    expect(report.gates.failures).toContain(
      "barge-in run 0 emitted 18 audio frame(s) after interrupt silence",
    );
  });

  it("fails gates when TTS finishes before the scheduled barge-in interrupt", async () => {
    const result = await runBargeTurn(
      bargeInCorpus(),
      createDeterministicTts({ frameCount: 2 }),
    );
    const report = reportFor([result]);

    expect(result.trace.cancelled).toBe(false);
    expect(report.gates.passed).toBe(false);
    expect(report.gates.failures).toContain(
      "barge-in run 0 did not cancel active TTS during barge-in",
    );
  });
});

function createDeterministicTts(options: {
  frameCount: number;
  ignoreCancellation?: boolean;
  onEmit?: (frame: TtsFrame) => void;
}): TtsAdapter {
  return {
    name: "deterministic-tts",
    async synthesize({ corpus, requestAtMs, onAudioFrame }) {
      const firstAudioAtMs =
        requestAtMs + corpus.mockTimingsMs.ttsFirstAudioAfterRequest;
      const frames: TtsFrame[] = [];
      let cancelled = false;
      for (let index = 0; index < options.frameCount; index++) {
        const frame = {
          atMs: firstAudioAtMs + index * 40,
          bytes: 640,
        };
        options.onEmit?.(frame);
        const shouldContinue = onAudioFrame(frame);
        if (!shouldContinue) {
          cancelled = true;
          if (!options.ignoreCancellation) break;
          continue;
        }
        frames.push(frame);
      }
      return {
        firstAudioAtMs,
        frames,
        cancelled,
        requestId: "deterministic-tts",
      };
    },
  };
}

async function runBargeTurn(
  corpus: CorpusCase,
  tts: TtsAdapter,
): Promise<CaseResult> {
  const adapters = createMockAdapters();
  return runTurn({
    corpus,
    runIndex: 0,
    traceId: "trace-barge-in-0",
    mode: "mock",
    stt: adapters.stt,
    llm: adapters.llm,
    tts,
    timeoutMs: 1000,
    unsafeTranscripts: false,
  });
}

function reportFor(results: CaseResult[]) {
  return buildReport({
    generatedAt: "2026-07-10T00:00:00.000Z",
    mode: "mock",
    providers: {
      stt: "mock",
      llm: "mock",
      tts: "test",
    },
    results,
    enforceGates: true,
  });
}

function bargeInCorpus(): CorpusCase {
  const corpus = loadCorpus().find((entry) => entry.kind === "barge-in");
  if (!corpus) throw new Error("barge-in corpus missing");
  return corpus;
}
