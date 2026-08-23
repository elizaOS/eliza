/**
 * Verifies safe sorting in meetings pipeline and VoteLockTable when timestamps or vote weights contain NaN.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { VoteLockTable } from "../../platforms/googlemeet/speaker-identity.js";
import { createMeetingTranscriptionPipeline } from "../pipeline.js";
import type { AsrBackend, AsrTranscribeOptions, AsrTranscribeResult } from "../transcriber.js";

const SR = 16_000;
const SESSION_ID = "12345678-1111-2222-3333-444455556666" as UUID;
const seconds = (s: number, fill = 0.1): Float32Array =>
  new Float32Array(Math.round(s * SR)).fill(fill);

class ScriptedBackend implements AsrBackend {
  private queue: AsrTranscribeResult[] = [];
  enqueue(...results: AsrTranscribeResult[]): void {
    this.queue.push(...results);
  }
  async transcribe(_wav: Buffer, _opts: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    return this.queue.shift() ?? { text: "" };
  }
}

describe("meetings safe sort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("safely resolves speaker bestGuess and recordVote when weights contain NaN or non-finite values", () => {
    const tracker = new VoteLockTable();

    tracker.recordVote(1, "Alice", 1.0);
    tracker.recordVote(1, "Bob", NaN);
    tracker.recordVote(1, "Charlie", 2.0);

    const guess = tracker.bestGuess(1);
    expect(guess).toBeDefined();
    // Non-finite weight falls back to 0, so Charlie (2.0) is top guess
    expect(guess).toBe("Charlie");
  });

  it("safely finalizes meeting transcription pipeline segments in chronological order", async () => {
    const backend = new ScriptedBackend();
    backend.enqueue(
      { text: "segment zero" },
      { text: "segment zero" },
      { text: "segment one" },
      { text: "segment one" },
    );

    const pipeline = createMeetingTranscriptionPipeline(
      {
        runtime: {} as IAgentRuntime,
        sessionId: SESSION_ID,
        retainAudio: false,
      },
      backend,
    );

    pipeline.pushSpeakerAudio("t0", seconds(2));
    await vi.advanceTimersByTimeAsync(2000);
    pipeline.pushSpeakerAudio("t1", seconds(2));
    await vi.advanceTimersByTimeAsync(2000);

    const finalized = await pipeline.finalize();
    expect(finalized).toBeDefined();
    expect(Array.isArray(finalized)).toBe(true);
    for (let i = 1; i < finalized.length; i++) {
      expect(finalized[i].startMs).toBeGreaterThanOrEqual(finalized[i - 1].startMs);
    }
  });
});
