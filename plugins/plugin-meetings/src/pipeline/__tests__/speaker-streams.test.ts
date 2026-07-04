/**
 * SpeakerStreamManager confirmation logic — LocalAgreement-2 word-prefix
 * matching and the full-text double-match fallback. Deterministic, injected
 * clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AsrSegment,
  type AsrSubmissionPurpose,
  type ConfirmedSegmentEvent,
  SpeakerStreamManager,
} from "../speaker-streams";

const SR = 16_000;
const seconds = (s: number): Float32Array =>
  new Float32Array(Math.round(s * SR));
const seg = (text: string, startSec: number, endSec: number): AsrSegment => ({
  text,
  startSec,
  endSec,
});

interface Harness {
  manager: SpeakerStreamManager;
  submissions: Array<{
    speakerKey: string;
    samples: number;
    purpose: AsrSubmissionPurpose;
  }>;
  confirmed: ConfirmedSegmentEvent[];
}

function harness(
  config?: ConstructorParameters<typeof SpeakerStreamManager>[0],
): Harness {
  const manager = new SpeakerStreamManager(config);
  const submissions: Harness["submissions"] = [];
  const confirmed: ConfirmedSegmentEvent[] = [];
  manager.onSegmentReady = (speakerKey, _name, audio, purpose) => {
    submissions.push({ speakerKey, samples: audio.length, purpose });
  };
  manager.onSegmentConfirmed = (event) => {
    confirmed.push(event);
  };
  return { manager, submissions, confirmed };
}

describe("SpeakerStreamManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("submits only unconfirmed audio on the 2s cadence once ≥2s buffered", () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");

    h.manager.feedAudio("a", seconds(1));
    vi.advanceTimersByTime(2000);
    expect(h.submissions).toHaveLength(0); // below minAudioDuration

    h.manager.feedAudio("a", seconds(1.5));
    vi.advanceTimersByTime(2000);
    expect(h.submissions).toEqual([
      { speakerKey: "a", samples: 2.5 * SR, purpose: "interim" },
    ]);

    // In-flight — no double submission
    vi.advanceTimersByTime(2000);
    expect(h.submissions).toHaveLength(1);
  });

  describe("LocalAgreement-2 word-prefix confirmation", () => {
    it("confirms the stable word prefix across growing re-submissions and advances the offset", () => {
      const h = harness();
      h.manager.addSpeaker("a", "Alice");
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      expect(h.submissions).toHaveLength(1);

      // First submission: nothing to agree with yet.
      h.manager.handleTranscriptionResult("a", "hello world", 1.0, [
        seg("hello world", 0, 1.0),
      ]);
      expect(h.confirmed).toHaveLength(0);

      // Grown re-submission: "hello world" is a stable prefix, whole first
      // segment confirmed; trailing segment still forming.
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      expect(h.submissions[1].samples).toBe(4 * SR); // nothing trimmed yet
      expect(h.submissions[1].purpose).toBe("interim");
      h.manager.handleTranscriptionResult("a", "hello world how are", 2.4, [
        seg("hello world", 0, 1.0),
        seg("how are", 1.0, 2.4),
      ]);
      expect(h.confirmed).toHaveLength(1);
      expect(h.confirmed[0]).toMatchObject({
        speakerKey: "a",
        speakerName: "Alice",
        text: "hello world",
        startMs: 0,
        endMs: 1000,
        seq: 0,
      });

      // Offset advanced to the confirmed boundary (1.0s trimmed) — the next
      // submission carries only the unconfirmed remainder.
      h.manager.feedAudio("a", seconds(1));
      vi.advanceTimersByTime(2000);
      expect(h.submissions[2].samples).toBe(4 * SR); // (4s+1s) - 1.0s confirmed
      expect(h.submissions[2].purpose).toBe("interim");
    });

    it("does not emit a corrected (unstable) tail", () => {
      const h = harness();
      h.manager.addSpeaker("a", "Alice");
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "I scream", 1.0, [
        seg("I scream", 0, 1.0),
      ]);
      // ASR revised the words entirely — no common prefix, no confirmation.
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "ice cream is great", 2.0, [
        seg("ice cream is great", 0, 2.0),
      ]);
      expect(h.confirmed).toHaveLength(0);
    });

    it("carries word timings onto confirmed segments as absolute ms", () => {
      const h = harness();
      h.manager.addSpeaker("a", "Alice");
      vi.setSystemTime(5000); // window starts when audio arrives
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      const withWords: AsrSegment = {
        text: "hi there",
        startSec: 0,
        endSec: 0.9,
        words: [
          { text: "hi", startSec: 0.1, endSec: 0.4 },
          { text: "there", startSec: 0.5, endSec: 0.9 },
        ],
      };
      h.manager.handleTranscriptionResult("a", "hi there", 0.9, [withWords]);
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "hi there friend", 2.0, [
        withWords,
        seg("friend", 1.0, 2.0),
      ]);
      expect(h.confirmed).toHaveLength(1);
      expect(h.confirmed[0].startMs).toBe(5000);
      expect(h.confirmed[0].words).toEqual([
        { text: "hi", startMs: 5100, endMs: 5400 },
        { text: "there", startMs: 5500, endMs: 5900 },
      ]);
    });
  });

  describe("full-text double-match fallback", () => {
    it("confirms after two identical submissions and dedups re-emissions", () => {
      const h = harness();
      h.manager.addSpeaker("a", "Alice");
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "the roadmap looks solid");
      expect(h.confirmed).toHaveLength(0);

      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "the roadmap looks solid");
      expect(h.confirmed).toHaveLength(1);
      expect(h.confirmed[0].text).toBe("the roadmap looks solid");

      // Residual echo re-confirming the same text is deduped.
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "the roadmap looks solid");
      h.manager.feedAudio("a", seconds(2));
      vi.advanceTimersByTime(2000);
      h.manager.handleTranscriptionResult("a", "the roadmap looks solid");
      expect(h.confirmed).toHaveLength(1);
    });

    it("filters hallucinations before they enter confirmation", () => {
      const h = harness();
      h.manager.addSpeaker("a", "Alice");
      for (let i = 0; i < 3; i++) {
        h.manager.feedAudio("a", seconds(2));
        vi.advanceTimersByTime(2000);
        h.manager.handleTranscriptionResult("a", " Thanks for watching!");
      }
      expect(h.confirmed).toHaveLength(0);
    });
  });

  it("idle timeout makes one final submission and emits its result immediately", () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.feedAudio("a", seconds(1)); // below cadence minimum
    vi.advanceTimersByTime(16_000); // > 15s idle
    expect(h.submissions).toEqual([
      { speakerKey: "a", samples: SR, purpose: "final" },
    ]);

    h.manager.handleTranscriptionResult("a", "short final remark");
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0].text).toBe("short final remark");
  });

  it("hard cap force-flushes an unconfirmed transcript at 30s", () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.feedAudio("a", seconds(29));
    vi.advanceTimersByTime(2000);
    expect(h.submissions).toHaveLength(1);
    h.manager.handleTranscriptionResult(
      "a",
      "a very long unconfirmed monologue",
    );

    h.manager.feedAudio("a", seconds(2)); // total 31s > cap
    vi.advanceTimersByTime(2000);
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0].text).toBe("a very long unconfirmed monologue");

    // Buffer fully reset — nothing left to submit.
    vi.advanceTimersByTime(4000);
    expect(h.submissions).toHaveLength(1);
  });

  it("discards stale in-flight results after a full reset (generation bump)", async () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.feedAudio("a", seconds(2));
    vi.advanceTimersByTime(2000);
    expect(h.submissions).toHaveLength(1);

    // Reset while the request is in flight (no transcript yet + inFlight →
    // flushSpeaker falls through to a full reset with a generation bump).
    await h.manager.flushSpeaker("a");
    h.manager.handleTranscriptionResult(
      "a",
      "stale text from dead audio",
      2.0,
      [seg("stale text from dead audio", 0, 2.0)],
    );
    expect(h.confirmed).toHaveLength(0);
    expect(h.manager.getPendingSnapshot("a")).toBeNull();
  });

  it("speaker-change flush emits the forming transcript immediately", async () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.feedAudio("a", seconds(2));
    vi.advanceTimersByTime(2000);
    h.manager.handleTranscriptionResult("a", "before the handoff");
    expect(h.confirmed).toHaveLength(0);

    await h.manager.flushSpeaker("a");
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0].text).toBe("before the handoff");
  });

  it("keeps independent multi-speaker streams interleaved without cross-talk", () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.addSpeaker("b", "Bob");
    h.manager.feedAudio("a", seconds(2));
    h.manager.feedAudio("b", seconds(2));
    vi.advanceTimersByTime(2000);
    expect(h.submissions.map((s) => s.speakerKey).sort()).toEqual(["a", "b"]);

    h.manager.handleTranscriptionResult("a", "alpha topic", 1.0, [
      seg("alpha topic", 0, 1),
    ]);
    h.manager.handleTranscriptionResult("b", "beta topic", 1.0, [
      seg("beta topic", 0, 1),
    ]);
    h.manager.feedAudio("a", seconds(2));
    h.manager.feedAudio("b", seconds(2));
    vi.advanceTimersByTime(2000);
    h.manager.handleTranscriptionResult(
      "a",
      "alpha topic continues here",
      2.0,
      [seg("alpha topic", 0, 1), seg("continues here", 1, 2)],
    );
    h.manager.handleTranscriptionResult("b", "beta topic diverges now", 2.0, [
      seg("beta topic", 0, 1),
      seg("diverges now", 1, 2),
    ]);

    expect(h.confirmed.map((c) => [c.speakerKey, c.text])).toEqual([
      ["a", "alpha topic"],
      ["b", "beta topic"],
    ]);
    expect(
      h.confirmed.every(
        (c) => c.speakerName === (c.speakerKey === "a" ? "Alice" : "Bob"),
      ),
    ).toBe(true);
  });

  it("removeSpeaker emits the leftover forming transcript and clears timers", () => {
    const h = harness();
    h.manager.addSpeaker("a", "Alice");
    h.manager.feedAudio("a", seconds(2));
    vi.advanceTimersByTime(2000);
    h.manager.handleTranscriptionResult("a", "leftover words");
    h.manager.removeSpeaker("a");
    expect(h.confirmed.map((c) => c.text)).toEqual(["leftover words"]);
    expect(h.manager.hasSpeaker("a")).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(h.submissions).toHaveLength(1); // timer gone
  });
});
