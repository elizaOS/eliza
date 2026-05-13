/**
 * Tests for the `VoicePipeline` seam implementations (`pipeline-impls.ts`)
 * plus the shared `splitTranscriptToTokens` helper (`pipeline.ts`):
 *   - `splitTranscriptToTokens` round-trips to the original text on join()
 *   - `MissingAsrTranscriber` hard-fails (AGENTS.md §3 — no silent fallback)
 *   - `LlamaServerDraftProposer` honours `maxDraft`, returns [] with no drafter,
 *     and returns [] on cancel
 *   - `LlamaServerTargetVerifier` derives accept tokens + `done` from the
 *     server's streamed deltas (and falls back to splitting plain text)
 *   - the impls drive a real `VoicePipeline` end-to-end through a
 *     `VoiceScheduler` (wired-through path) with a stub `StreamingTranscriber`
 */

import { describe, expect, it } from "vitest";
import { VoiceStartupError } from "./errors";
import { splitTranscriptToTokens, VoicePipeline } from "./pipeline";
import {
  type DflashTextRunner,
  LlamaServerDraftProposer,
  LlamaServerTargetVerifier,
  MissingAsrTranscriber,
} from "./pipeline-impls";
import { InMemoryAudioSink } from "./ring-buffer";
import { VoiceScheduler } from "./scheduler";
import type {
  SpeakerPreset,
  StreamingTranscriber,
  TranscriptionAudio,
  TranscriptUpdate,
  VerifierStreamEvent,
} from "./types";

function makePreset(): SpeakerPreset {
  const embedding = new Float32Array([0.1, 0.2]);
  return {
    voiceId: "default",
    embedding,
    bytes: new Uint8Array(embedding.buffer.slice(0)),
  };
}

const audio: TranscriptionAudio = {
  pcm: new Float32Array(2400),
  sampleRate: 16_000,
};

/**
 * Minimal `StreamingTranscriber` stub for the wired-through test: `feed`
 * accumulates nothing, `flush()` returns the supplied transcript.
 */
function stubTranscriber(transcript: string): StreamingTranscriber {
  return {
    feed: () => {},
    async flush(): Promise<TranscriptUpdate> {
      return { partial: transcript, isFinal: true };
    },
    on: () => () => {},
    dispose: () => {},
  };
}

/**
 * Fake `DflashTextRunner`. Each `generateWithVerifierEvents` call pops the
 * next scripted response: a list of token texts (emitted as one accept
 * event) plus the joined string as `text`.
 */
function fakeRunner(args: {
  hasDrafter: boolean;
  responses: string[][];
}): DflashTextRunner & { calls: number } {
  let i = 0;
  const runner = {
    calls: 0,
    hasDrafter: () => args.hasDrafter,
    async generateWithVerifierEvents(callArgs: {
      onVerifierEvent: (e: VerifierStreamEvent) => void | Promise<void>;
    }) {
      runner.calls++;
      const toks = args.responses[i++] ?? [];
      if (toks.length > 0) {
        await callArgs.onVerifierEvent({
          kind: "accept",
          tokens: toks.map((t, idx) => ({ index: idx, text: t })),
        });
      }
      return { text: toks.join("") };
    },
  };
  return runner;
}

describe("splitTranscriptToTokens", () => {
  it("returns no tokens for empty / whitespace input", () => {
    expect(splitTranscriptToTokens("")).toEqual([]);
    expect(splitTranscriptToTokens("   ")).toEqual([]);
  });

  it("round-trips to the original (trimmed) text on join", () => {
    const tokens = splitTranscriptToTokens("hello there world", 5);
    expect(tokens.map((t) => t.text).join("")).toBe("hello there world");
    expect(tokens[0].index).toBe(5);
    expect(tokens.at(-1)?.index).toBe(5 + tokens.length - 1);
  });

  it("attaches token ids only when their count matches the chunk count", () => {
    const matched = splitTranscriptToTokens("a b c", 0, [10, 11, 12]);
    expect(matched.map((t) => t.id)).toEqual([10, 11, 12]);
    const mismatched = splitTranscriptToTokens("a b c", 0, [10, 11]);
    expect(mismatched.every((t) => t.id === undefined)).toBe(true);
  });
});

describe("MissingAsrTranscriber", () => {
  it("throws VoiceStartupError instead of falling back (AGENTS.md §3)", async () => {
    const t = new MissingAsrTranscriber("no asr region");
    expect(() =>
      t.feed({ pcm: new Float32Array(0), sampleRate: 16_000, timestampMs: 0 }),
    ).toThrow(VoiceStartupError);
    await expect(t.flush()).rejects.toThrow(VoiceStartupError);
  });

  it("surfaces the hard failure through a VoicePipeline turn", async () => {
    const sink = new InMemoryAudioSink();
    const scheduler = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 4 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend: new StubBackend(), sink },
    );
    const pipeline = new VoicePipeline(
      {
        scheduler,
        transcriber: new MissingAsrTranscriber("no asr region"),
        drafter: new LlamaServerDraftProposer(
          fakeRunner({ hasDrafter: false, responses: [] }),
        ),
        verifier: new LlamaServerTargetVerifier(
          fakeRunner({ hasDrafter: false, responses: [] }),
        ),
      },
      { maxDraftTokens: 4 },
    );
    await expect(pipeline.run(audio)).rejects.toThrow(VoiceStartupError);
  });
});

describe("LlamaServerDraftProposer", () => {
  it("returns the drafted tokens, clamped to maxDraft", async () => {
    const runner = fakeRunner({
      hasDrafter: true,
      responses: [["A", "B", "C", "D"]],
    });
    const proposer = new LlamaServerDraftProposer(runner);
    const draft = await proposer.propose({
      prefix: [{ index: 0, text: "q" }],
      maxDraft: 2,
      cancel: { cancelled: false },
    });
    expect(draft.map((t) => t.text)).toEqual(["A", "B"]);
    expect(draft[0].index).toBe(1); // after prefix token index 0
  });

  it("returns [] when no drafter is wired", async () => {
    const runner = fakeRunner({ hasDrafter: false, responses: [["A"]] });
    const proposer = new LlamaServerDraftProposer(runner);
    const draft = await proposer.propose({
      prefix: [],
      maxDraft: 4,
      cancel: { cancelled: false },
    });
    expect(draft).toEqual([]);
    expect(runner.calls).toBe(0);
  });

  it("returns [] immediately when cancelled", async () => {
    const runner = fakeRunner({ hasDrafter: true, responses: [["A"]] });
    const proposer = new LlamaServerDraftProposer(runner);
    const draft = await proposer.propose({
      prefix: [],
      maxDraft: 4,
      cancel: { cancelled: true },
    });
    expect(draft).toEqual([]);
    expect(runner.calls).toBe(0);
  });
});

describe("LlamaServerTargetVerifier", () => {
  it("derives accepted tokens + done from streamed deltas", async () => {
    // Step budget for an empty draft is 1; the runner emits exactly one
    // token, so the verifier reports done (produced < budget? produced==1,
    // budget==1 → produced is NOT < budget → not done). Use a 2-token
    // response against a 1-token draft (budget 2) to get done=false, then
    // a short response to get done=true.
    const runner = fakeRunner({
      hasDrafter: true,
      responses: [["X", "Y"], ["Z"]],
    });
    const v = new LlamaServerTargetVerifier(runner);
    const r1 = await v.verify({
      prefix: [{ index: 0, text: "q" }],
      draft: [{ index: 1, text: "d" }],
      cancel: { cancelled: false },
    });
    expect(r1.accepted.map((t) => t.text)).toEqual(["X", "Y"]);
    expect(r1.done).toBe(false); // produced 2 == budget 2
    const r2 = await v.verify({
      prefix: [{ index: 0, text: "q" }],
      draft: [{ index: 1, text: "d" }],
      cancel: { cancelled: false },
    });
    expect(r2.accepted.map((t) => t.text)).toEqual(["Z"]);
    expect(r2.done).toBe(true); // produced 1 < budget 2
  });

  it("falls back to splitting plain text when the server emits no deltas", async () => {
    const noDeltaRunner: DflashTextRunner = {
      hasDrafter: () => true,
      async generateWithVerifierEvents() {
        return { text: "plain answer" };
      },
    };
    const v = new LlamaServerTargetVerifier(noDeltaRunner);
    const r = await v.verify({
      prefix: [],
      draft: [],
      cancel: { cancelled: false },
    });
    expect(r.accepted.map((t) => t.text).join("")).toBe("plain answer");
  });
});

describe("wired-through VoicePipeline (StreamingTranscriber + llama-server draft/verify)", () => {
  it("runs ASR → draft∥verify → chunker → TTS end to end", async () => {
    const transcriber = stubTranscriber("hi");
    // Round 1: drafter proposes ["foo."], verifier accepts ["foo.", " bar."]
    //   (budget for a 1-token draft = 2; produced == 2 → not done).
    // Round 2: drafter proposes nothing (empty), verifier accepts ["end."]
    //   (budget for an empty draft = 1; produced 1 == budget → NOT done...).
    // To terminate, round 3 the verifier returns [] (produced 0 < budget 1 → done).
    const draftRunner = fakeRunner({
      hasDrafter: true,
      responses: [["foo."], [], []],
    });
    const verifyRunner = fakeRunner({
      hasDrafter: true,
      responses: [["foo.", " bar."], ["end."], []],
    });
    const drafter = new LlamaServerDraftProposer(draftRunner);
    const verifier = new LlamaServerTargetVerifier(verifyRunner);
    const sink = new InMemoryAudioSink();
    const scheduler = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 4 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend: new StubBackend(), sink },
    );
    const pipeline = new VoicePipeline(
      { scheduler, transcriber, drafter, verifier },
      { maxDraftTokens: 4, maxGeneratedTokens: 64 },
    );
    const reason = await pipeline.run(audio);
    await scheduler.waitIdle();
    expect(reason).toBe("done");
    // Some audio reached the sink — "foo.", " bar.", "end." were synthesized
    // (rollback aside; this scenario has no rejects).
    expect(sink.chunks.length).toBeGreaterThan(0);
  });
});

class StubBackend {
  async synthesize(args: {
    phrase: { id: number; fromIndex: number; toIndex: number };
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }) {
    args.onKernelTick?.();
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm: new Float32Array(8).fill(0.1),
      sampleRate: 24000,
    };
  }
}
