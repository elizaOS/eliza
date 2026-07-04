/**
 * MeetingTranscriptionPipeline behavior — per-speaker buffering, ASR
 * confirmation, hallucination filtering, TranscriptSegment assembly, and the
 * retained-audio session mix. Deterministic: fake runtime plus scripted ASR, no
 * real model.
 */
import type { Buffer } from "node:buffer";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeetingBillingSession,
  MeetingPipelineOptions,
  PipelineTranscriptUpdate,
} from "../../types";
import { MeetingBillingError } from "../../types";
import { createMeetingTranscriptionPipeline } from "../pipeline";
import type {
  AsrBackend,
  AsrTranscribeOptions,
  AsrTranscribeResult,
} from "../transcriber";
import { wavToFloat32 } from "../wav";

const SR = 16_000;
const SESSION_ID = "12345678-1111-2222-3333-444455556666" as UUID;
const seconds = (s: number, fill = 0.1): Float32Array =>
  new Float32Array(Math.round(s * SR)).fill(fill);

/** Scripted ASR backend — the legitimate seam: the backend IS the boundary. */
class ScriptedBackend implements AsrBackend {
  calls: Array<{ wav: Buffer; opts: AsrTranscribeOptions }> = [];
  private queue: AsrTranscribeResult[] = [];
  private failures = 0;

  enqueue(...results: AsrTranscribeResult[]): void {
    this.queue.push(...results);
  }
  failNext(count: number): void {
    this.failures = count;
  }

  async transcribe(
    wav: Buffer,
    opts: AsrTranscribeOptions,
  ): Promise<AsrTranscribeResult> {
    this.calls.push({ wav, opts });
    if (this.failures > 0) {
      this.failures--;
      throw new Error("scripted ASR failure");
    }
    return this.queue.shift() ?? { text: "" };
  }
}

function options(
  overrides?: Partial<MeetingPipelineOptions>,
): MeetingPipelineOptions {
  return {
    runtime: {} as IAgentRuntime, // unused — backend injected
    sessionId: SESSION_ID,
    retainAudio: false,
    ...overrides,
  };
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
}

describe("createMeetingTranscriptionPipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("transcribes a speaker window through the backend with prompt continuity", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      { text: "welcome to the standup" },
      { text: "welcome to the standup" }, // double match → confirm
      { text: "first item is the release" },
    );
    const pipeline = createMeetingTranscriptionPipeline(
      options({ language: "en" }),
      backend,
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(backend.calls[0].opts.language).toBe("en");
    expect(backend.calls[0].opts.prompt).toBeUndefined();
    expect(backend.calls[0].opts.purpose).toBe("interim");

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    expect(backend.calls).toHaveLength(2);

    // Confirmed text becomes the next window's decoding prompt.
    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    expect(backend.calls[2].opts.prompt).toBe("welcome to the standup");
    expect(backend.calls[2].opts.purpose).toBe("interim");

    const segments = await pipeline.finalize();
    expect(segments.map((s) => s.text)).toContain("welcome to the standup");
  });

  it("does not call ASR when the billing meter cannot reserve the next window", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue({ text: "this should not run" });
    const billing: MeetingBillingSession = {
      state: {
        status: "reserved",
        reservedMs: 1000,
        consumedMs: 0,
        capMs: 1000,
      },
      reserveInitial: async () => undefined,
      ensureTranscriptionWindow: vi.fn(async () => {
        throw new MeetingBillingError(
          "insufficient_credits",
          "meeting spend cap reached",
        );
      }),
      reconcile: async () => ({
        status: "reconciled",
        reservedMs: 1000,
        consumedMs: 0,
      }),
    };
    const onSpendCapReached = vi.fn();
    const pipeline = createMeetingTranscriptionPipeline(
      options({ billing, onSpendCapReached }),
      backend,
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);

    expect(billing.ensureTranscriptionWindow).toHaveBeenCalledWith(2000);
    expect(backend.calls).toHaveLength(0);
    expect(onSpendCapReached).toHaveBeenCalledWith(
      expect.objectContaining({ code: "insufficient_credits" }),
    );
  });

  it("treats cloud billing errors with the insufficient-credit code as spend-cap stops", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue({ text: "this should not run" });
    const cloudBillingError = Object.assign(new Error("cloud cap reached"), {
      code: "insufficient_credits" as const,
    });
    const billing: MeetingBillingSession = {
      state: {
        status: "reserved",
        reservedMs: 1000,
        consumedMs: 0,
        capMs: 1000,
      },
      reserveInitial: async () => undefined,
      ensureTranscriptionWindow: vi.fn(async () => {
        throw cloudBillingError;
      }),
      reconcile: async () => ({
        status: "reconciled",
        reservedMs: 1000,
        consumedMs: 0,
      }),
    };
    const onSpendCapReached = vi.fn();
    const pipeline = createMeetingTranscriptionPipeline(
      options({ billing, onSpendCapReached }),
      backend,
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);

    expect(backend.calls).toHaveLength(0);
    expect(onSpendCapReached).toHaveBeenCalledWith(cloudBillingError);
  });

  it("emits confirmed (new-only) + pending replacement-tail updates", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      { text: "hello team lets begin" },
      { text: "hello team lets begin" },
    );
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);
    const updates: PipelineTranscriptUpdate[] = [];
    const unsubscribe = pipeline.onUpdate((u) =>
      updates.push({ confirmed: [...u.confirmed], pending: [...u.pending] }),
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    // First result: unconfirmed → pending tail only.
    const pendingUpdate = updates.find((u) => u.pending.length > 0);
    expect(pendingUpdate).toBeDefined();
    expect(pendingUpdate?.pending[0].text).toBe("hello team lets begin");
    expect(pendingUpdate?.pending[0].id).toBe("12345678:t0:pending");

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    const confirmedUpdate = updates.find((u) => u.confirmed.length > 0);
    expect(confirmedUpdate).toBeDefined();
    expect(confirmedUpdate?.confirmed).toHaveLength(1);
    expect(confirmedUpdate?.confirmed[0].id).toBe("12345678:t0:0");
    expect(confirmedUpdate?.confirmed[0].text).toBe("hello team lets begin");

    unsubscribe();
    const count = updates.length;
    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    expect(updates).toHaveLength(count); // unsubscribed
  });

  it("uses backend word timings for LocalAgreement and puts words on segments", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      {
        text: "good morning",
        words: [
          { text: "good", startMs: 0, endMs: 300 },
          { text: "morning", startMs: 350, endMs: 800 },
        ],
      },
      {
        text: "good morning everyone here",
        words: [
          { text: "good", startMs: 0, endMs: 300 },
          { text: "morning", startMs: 350, endMs: 800 },
          // >600ms gap → separate segment, so the stable prefix is a whole segment
          { text: "everyone", startMs: 1500, endMs: 1900 },
          { text: "here", startMs: 1950, endMs: 2300 },
        ],
      },
    );
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);

    const segments = await pipeline.finalize();
    const confirmed = segments.find((s) => s.text === "good morning");
    expect(confirmed).toBeDefined();
    expect(confirmed?.words).toEqual([
      { text: "good", startMs: 0, endMs: 300 },
      { text: "morning", startMs: 350, endMs: 800 },
    ]);
    expect(confirmed?.startMs).toBe(0);
    expect(confirmed?.endMs).toBe(800);
  });

  it("labels speakers: setSpeakerName wins, 'Speaker N' fallback otherwise", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      { text: "alice reporting status" },
      { text: "second stream reporting in" },
      { text: "alice reporting status" },
      { text: "second stream reporting in" },
    );
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);
    pipeline.setSpeakerName("track-1", "Alice Chen");

    pipeline.pushSpeakerAudio("track-1", seconds(2));
    pipeline.pushSpeakerAudio("track-2", seconds(2));
    await tick(2000);
    pipeline.pushSpeakerAudio("track-1", seconds(2));
    pipeline.pushSpeakerAudio("track-2", seconds(2));
    await tick(2000);

    const segments = await pipeline.finalize();
    const labels = new Set(segments.map((s) => s.speakerLabel));
    expect(labels).toContain("Alice Chen");
    expect(labels).toContain("Speaker 1"); // first unnamed stream
    expect(pipeline.speakerNames().sort()).toEqual(["Alice Chen", "Speaker 1"]);
  });

  it("finalize drains in-flight ASR, flushes forming transcripts, and orders segments", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      { text: "alpha speaks first" },
      { text: "beta speaks second" },
      { text: "alpha speaks first" }, // flush-submit answers during finalize
      { text: "beta speaks second" },
    );
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);

    pipeline.pushSpeakerAudio("a", seconds(2));
    await tick(1000);
    pipeline.pushSpeakerAudio("b", seconds(2));
    await tick(1000); // a submits at t=2000; b at t=3000 (its own cadence)
    await tick(1000);

    const segments = await pipeline.finalize();
    expect(segments.map((s) => s.text)).toEqual([
      "alpha speaks first",
      "beta speaks second",
    ]);
    expect(segments[0].startMs).toBeLessThanOrEqual(segments[1].startMs);
    expect(backend.calls.map((call) => call.opts.purpose)).toEqual([
      "interim",
      "interim",
    ]);

    // Finalized pipeline ignores new audio and returns the same segments.
    pipeline.pushSpeakerAudio("a", seconds(2));
    await tick(4000);
    expect(await pipeline.finalize()).toHaveLength(2);
  });

  it("marks a terminal no-transcript flush as a final ASR submission", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue({ text: "short closing thought" });
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);

    pipeline.pushSpeakerAudio("a", seconds(1)); // below cadence minimum

    const segments = await pipeline.finalize();
    expect(segments.map((s) => s.text)).toEqual(["short closing thought"]);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0].opts.purpose).toBe("final");
  });

  it("drops a window whose ASR fails and keeps the stream moving", async () => {
    const backend = new ScriptedBackend();
    backend.failNext(1);
    backend.enqueue(
      { text: "recovered after the failure" },
      { text: "recovered after the failure" },
    );
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000); // fails — window dropped, inFlight cleared
    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);
    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000);

    const segments = await pipeline.finalize();
    expect(segments.map((s) => s.text)).toEqual([
      "recovered after the failure",
    ]);
  });

  it("surfaces an ASR window failure via runtime.reportError (not a silent empty transcript)", async () => {
    const backend = new ScriptedBackend();
    backend.failNext(1);
    const reportError = vi.fn();
    const pipeline = createMeetingTranscriptionPipeline(
      options({ runtime: { reportError } as unknown as IAgentRuntime }),
      backend,
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await tick(2000); // ASR rejects — window dropped, failure must be reported

    expect(reportError).toHaveBeenCalledTimes(1);
    const [scope, err, context] = reportError.mock.calls[0];
    expect(scope).toBe("MeetingPipeline.transcribe");
    expect((err as Error).message).toBe("scripted ASR failure");
    expect(context).toMatchObject({ sessionId: SESSION_ID, speakerKey: "t0" });

    // Dropping the window still yields an empty (not fabricated) transcript.
    const segments = await pipeline.finalize();
    expect(segments).toEqual([]);
  });

  it("flushSpeaker (sink) force-finalizes a speaker's forming transcript", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue({ text: "handing over to bob now" });
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);

    pipeline.pushSpeakerAudio("a", seconds(2));
    await tick(2000);
    pipeline.flushSpeaker("a"); // speaker change — emit the forming text
    await tick(0);

    const segments = await pipeline.finalize();
    expect(segments.map((s) => s.text)).toEqual(["handing over to bob now"]);
  });

  it("tracks the participant roster without affecting transcription", async () => {
    const backend = new ScriptedBackend();
    const pipeline = createMeetingTranscriptionPipeline(options(), backend);
    pipeline.participantJoined({
      id: "p1",
      displayName: "Alice",
      joinedAtMs: 0,
    });
    pipeline.participantLeft("p1", 5000);
    pipeline.participantLeft("ghost", 6000); // unknown id is a no-op
    expect(await pipeline.finalize()).toEqual([]);
  });

  describe("retainAudio session mix", () => {
    it("returns null when retainAudio is off or nothing captured", async () => {
      const off = createMeetingTranscriptionPipeline(
        options(),
        new ScriptedBackend(),
      );
      expect(off.sessionAudioWav()).toBeNull();
      const on = createMeetingTranscriptionPipeline(
        options({ retainAudio: true }),
        new ScriptedBackend(),
      );
      expect(on.sessionAudioWav()).toBeNull();
    });

    it("mixes speakers at session offsets with a clipping guard", async () => {
      const pipeline = createMeetingTranscriptionPipeline(
        options({ retainAudio: true }),
        new ScriptedBackend(),
      );
      pipeline.pushSpeakerAudio("a", seconds(1, 0.8));
      pipeline.pushSpeakerAudio("b", seconds(1, 0.8)); // same offset → sums to 1.6, clipped
      await tick(1000);
      pipeline.pushSpeakerAudio("a", seconds(1, -0.25)); // 1s in

      const wav = pipeline.sessionAudioWav();
      expect(wav).not.toBeNull();
      const { samples, sampleRate } = wavToFloat32(wav as Buffer);
      expect(sampleRate).toBe(SR);
      expect(samples.length).toBe(2 * SR);
      expect(samples[0]).toBeCloseTo(1, 2); // clipped, not wrapped
      expect(samples[SR + 100]).toBeCloseTo(-0.25, 2);
      await pipeline.finalize();
    });

    it("releases retained PCM after the one-shot read so it does not leak (BL-4)", async () => {
      const pipeline = createMeetingTranscriptionPipeline(
        options({ retainAudio: true }),
        new ScriptedBackend(),
      );
      pipeline.pushSpeakerAudio("a", seconds(1, 0.5));
      await tick(1000);

      // First (terminal) read returns the mix…
      const wav = pipeline.sessionAudioWav();
      expect(wav).not.toBeNull();
      // …and drops the retained chunks: a second read finds nothing retained.
      expect(pipeline.sessionAudioWav()).toBeNull();
      await pipeline.finalize();
    });
  });
});
