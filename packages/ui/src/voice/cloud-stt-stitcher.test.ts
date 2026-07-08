// Unit tests for the chunked-segment cloud STT stitcher (voice V2a).
// Pure logic — no DOM, no network. Covers ordering, dedup, seam overlap, and
// finalize semantics called out in VOICE-STREAMING-DESIGN §2.5 + the lane spec
// (out-of-order/duplicate chunk handling, incremental transcript assembly).

import { describe, expect, it } from "vitest";
import {
  CloudSttSessionStitcher,
  seamOverlapWordCount,
} from "./cloud-stt-stitcher";

describe("seamOverlapWordCount", () => {
  it("returns 0 when there is no overlap", () => {
    expect(
      seamOverlapWordCount(["turn", "on"], ["the", "kitchen", "light"]),
    ).toBe(0);
  });

  it("detects a single-word seam overlap", () => {
    expect(
      seamOverlapWordCount(["turn", "on", "the"], ["the", "kitchen"]),
    ).toBe(1);
  });

  it("detects a multi-word seam overlap and prefers the longest", () => {
    expect(
      seamOverlapWordCount(
        ["please", "turn", "on", "the"],
        ["on", "the", "kitchen", "light"],
      ),
    ).toBe(2);
  });

  it("matches case- and punctuation-insensitively at the seam", () => {
    expect(seamOverlapWordCount(["the"], ["The,"])).toBe(1);
    expect(seamOverlapWordCount(["Light."], ["light"])).toBe(1);
  });

  it("does not match on punctuation-only tokens", () => {
    // A trailing "," token has an empty word key; it must not count as overlap.
    expect(seamOverlapWordCount(["hello", ","], [",", "world"])).toBe(0);
  });

  it("is bounded by the maxOverlapWords window", () => {
    // A genuine 5-word suffix/prefix seam: running ends with c d e f g, incoming
    // begins with c d e f g. The seam is only detectable when the window admits
    // its full length (a k-overlap must match as a whole suffix==prefix).
    const running = ["a", "b", "c", "d", "e", "f", "g"];
    const incoming = ["c", "d", "e", "f", "g", "h", "i"];
    // Window >= 5 finds the full seam.
    expect(seamOverlapWordCount(running, incoming, 5)).toBe(5);
    expect(seamOverlapWordCount(running, incoming, 10)).toBe(5);
    // A window smaller than the true seam can't confirm it (partial windows are
    // different alignments), so it reports 0 rather than a wrong partial dedup.
    expect(seamOverlapWordCount(running, incoming, 3)).toBe(0);
  });
});

describe("CloudSttSessionStitcher — in-order assembly", () => {
  it("appends segments in order with seam dedup", () => {
    const s = new CloudSttSessionStitcher();
    expect(s.push({ seq: 0, text: "turn on the", isFinal: false })).toBe(
      "turn on the",
    );
    // Segment 1 repeats the overlapped "the" (audio overlap) — deduped.
    expect(
      s.push({ seq: 1, text: "the kitchen light", isFinal: true }),
    ).toBe("turn on the kitchen light");
    expect(s.isDone).toBe(true);
  });

  it("handles a clean (no-overlap) boundary", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "hello there", isFinal: false });
    expect(s.push({ seq: 1, text: "general kenobi", isFinal: true })).toBe(
      "hello there general kenobi",
    );
  });

  it("ignores empty segments", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "start", isFinal: false });
    expect(s.push({ seq: 1, text: "   ", isFinal: false })).toBe("start");
    expect(s.push({ seq: 2, text: "end", isFinal: true })).toBe("start end");
  });
});

describe("CloudSttSessionStitcher — out-of-order + duplicate delivery", () => {
  it("buffers a segment that arrives ahead of the frontier", () => {
    const s = new CloudSttSessionStitcher();
    // seq 1 arrives before seq 0 (concurrent transcription).
    expect(s.push({ seq: 1, text: "world", isFinal: true })).toBe("");
    expect(s.pendingCount).toBe(1);
    // seq 0 lands → both flush in order.
    expect(s.push({ seq: 0, text: "hello", isFinal: false })).toBe(
      "hello world",
    );
    expect(s.pendingCount).toBe(0);
    expect(s.isDone).toBe(true);
  });

  it("drains a multi-segment contiguous run when the gap fills", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 3, text: "four", isFinal: true });
    s.push({ seq: 1, text: "two", isFinal: false });
    s.push({ seq: 2, text: "three", isFinal: false });
    expect(s.pendingCount).toBe(3);
    // seq 0 unblocks the whole chain 0→1→2→3.
    expect(s.push({ seq: 0, text: "one", isFinal: false })).toBe(
      "one two three four",
    );
    expect(s.isDone).toBe(true);
    expect(s.pendingCount).toBe(0);
  });

  it("is idempotent on a re-delivered seq (retry that resolves twice)", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "alpha", isFinal: false });
    s.push({ seq: 1, text: "beta", isFinal: true });
    const before = s.running;
    // Re-delivery of already-applied seqs is a no-op.
    expect(s.push({ seq: 0, text: "alpha", isFinal: false })).toBe(before);
    expect(s.push({ seq: 1, text: "beta", isFinal: true })).toBe(before);
    expect(s.running).toBe("alpha beta");
  });

  it("keeps the first copy of a duplicated buffered seq", () => {
    const s = new CloudSttSessionStitcher();
    // Two deliveries of seq 1 while seq 0 is still missing — first wins.
    s.push({ seq: 1, text: "first", isFinal: false });
    s.push({ seq: 1, text: "second", isFinal: false });
    expect(s.pendingCount).toBe(1);
    s.push({ seq: 0, text: "zero", isFinal: false });
    expect(s.running).toBe("zero first");
  });

  it("ignores negative / stale seqs", () => {
    const s = new CloudSttSessionStitcher();
    expect(s.push({ seq: -1, text: "junk", isFinal: false })).toBe("");
    expect(s.running).toBe("");
  });
});

describe("CloudSttSessionStitcher — finalize + reset", () => {
  it("hasContiguousThrough tracks the applied frontier", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "a", isFinal: false });
    expect(s.hasContiguousThrough(0)).toBe(true);
    expect(s.hasContiguousThrough(1)).toBe(false);
    s.push({ seq: 1, text: "b", isFinal: true });
    expect(s.hasContiguousThrough(1)).toBe(true);
  });

  it("reset() clears the session for reuse", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "old turn", isFinal: true });
    s.reset();
    expect(s.running).toBe("");
    expect(s.isDone).toBe(false);
    expect(s.pendingCount).toBe(0);
    expect(s.push({ seq: 0, text: "new turn", isFinal: false })).toBe(
      "new turn",
    );
  });

  it("finalizes even when the final segment's own text is empty", () => {
    const s = new CloudSttSessionStitcher();
    s.push({ seq: 0, text: "complete utterance", isFinal: false });
    // The tail segment transcribed to nothing (trailing silence) but is final.
    s.push({ seq: 1, text: "", isFinal: true });
    expect(s.isDone).toBe(true);
    expect(s.running).toBe("complete utterance");
  });
});
