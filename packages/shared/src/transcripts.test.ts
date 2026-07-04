/**
 * Covers the pure transcript helpers in `transcripts.ts`: speaker counting,
 * duration, plain-text/preview rendering, word flattening, the active-word
 * binary search, list-row summarization (including meeting-metadata
 * projection), and ASR word-timing validation. All assertions run over
 * in-memory transcript fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  activeWordIndex,
  flattenTranscriptWords,
  summarizeTranscript,
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
  transcriptDurationMs,
  transcriptPlainText,
  transcriptPreview,
  transcriptSpeakerCount,
  validateAsrWordTimings,
} from "./transcripts.js";

const segs: TranscriptSegment[] = [
  {
    id: "s1",
    speakerLabel: "Alice",
    startMs: 0,
    endMs: 1000,
    text: "hello there",
    words: [
      { text: "hello", startMs: 0, endMs: 400 },
      { text: "there", startMs: 500, endMs: 1000 },
    ],
  },
  {
    id: "s2",
    speakerLabel: "Bob",
    startMs: 1200,
    endMs: 2000,
    text: "hi",
    words: [{ text: "hi", startMs: 1200, endMs: 2000 }],
  },
  {
    id: "s3",
    speakerLabel: "Alice",
    startMs: 2100,
    endMs: 2600,
    text: "bye",
    words: [{ text: "bye", startMs: 2100, endMs: 2600 }],
  },
];

describe("transcriptSpeakerCount", () => {
  it("counts distinct labels (ignores unlabeled)", () => {
    expect(transcriptSpeakerCount(segs)).toBe(2); // Alice, Bob
    expect(
      transcriptSpeakerCount([{ ...segs[0], speakerLabel: undefined }]),
    ).toBe(0);
  });
});

describe("transcriptDurationMs", () => {
  it("returns the largest segment end (0 when empty)", () => {
    expect(transcriptDurationMs(segs)).toBe(2600);
    expect(transcriptDurationMs([])).toBe(0);
  });
});

describe("transcriptPlainText", () => {
  it("renders speaker-labeled lines, dropping empties", () => {
    expect(transcriptPlainText(segs)).toBe(
      "Alice: hello there\nBob: hi\nAlice: bye",
    );
    expect(transcriptPlainText([{ ...segs[1], speakerLabel: undefined }])).toBe(
      "hi",
    );
    // An empty-text segment contributes no line (no dangling "Alice:").
    expect(transcriptPlainText([{ ...segs[0], text: "   ", words: [] }])).toBe(
      "",
    );
  });
});

describe("transcriptPreview", () => {
  it("flattens text and caps with an ellipsis", () => {
    expect(transcriptPreview(segs)).toBe("hello there hi bye");
    expect(transcriptPreview(segs, 8)).toBe("hello t…");
  });
});

describe("flattenTranscriptWords", () => {
  it("flattens with origin indices in time order", () => {
    const flat = flattenTranscriptWords(segs);
    expect(flat).toHaveLength(4);
    expect(flat[0]).toMatchObject({
      text: "hello",
      segmentIndex: 0,
      wordIndex: 0,
    });
    expect(flat[2]).toMatchObject({
      text: "hi",
      segmentIndex: 1,
      wordIndex: 0,
    });
    expect(flat[3]).toMatchObject({
      text: "bye",
      segmentIndex: 2,
      wordIndex: 0,
    });
  });
});

describe("activeWordIndex", () => {
  const flat = flattenTranscriptWords(segs);
  it("binary-searches the active word and holds through gaps", () => {
    expect(activeWordIndex(flat, -1)).toBe(-1); // before the first word
    expect(activeWordIndex(flat, 0)).toBe(0); // "hello"
    expect(activeWordIndex(flat, 450)).toBe(0); // gap after hello → still hello
    expect(activeWordIndex(flat, 500)).toBe(1); // "there"
    expect(activeWordIndex(flat, 1300)).toBe(2); // "hi"
    expect(activeWordIndex(flat, 5000)).toBe(3); // past the end → last word
  });
  it("returns -1 for an empty word list", () => {
    expect(activeWordIndex([], 100)).toBe(-1);
  });
});

describe("summarizeTranscript", () => {
  it("projects to a list-row summary", () => {
    const t: Transcript = {
      id: "t1",
      title: "Standup",
      createdAt: 1000,
      durationMs: 2600,
      audioUrl: "/api/media/abc.wav",
      segments: segs,
      source: "voice-session",
      scope: "owner-private",
      status: "ready",
      speakerCount: 2,
    };
    expect(summarizeTranscript(t)).toEqual({
      id: "t1",
      title: "Standup",
      createdAt: 1000,
      durationMs: 2600,
      speakerCount: 2,
      status: "ready",
      source: "voice-session",
      preview: "hello there hi bye",
      hasAudio: true,
    });
  });

  it("projects meeting fields (platform + participantCount) for a meeting row", () => {
    // The exact metadata shape the meetings writer persists
    // (plugin-meetings meeting-transcript-writer): { platform, participants }.
    const meeting: Transcript = {
      id: "m1",
      title: "Design sync",
      createdAt: 2000,
      durationMs: 2600,
      segments: segs,
      source: "meeting",
      scope: "owner-private",
      status: "recording",
      speakerCount: 2,
      metadata: {
        platform: "google_meet",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
        participants: [
          { id: "p1", displayName: "Alice" },
          { id: "p2", displayName: "Bob" },
          { id: "p3", displayName: "Carol" },
        ],
      },
    };
    const summary = summarizeTranscript(meeting);
    expect(summary.source).toBe("meeting");
    expect(summary.meeting).toEqual({
      platform: "google_meet",
      participantCount: 3,
    });
  });

  it("omits meeting fields and counts zero roster safely for non-meeting/empty metadata", () => {
    const t: Transcript = {
      id: "t2",
      title: "Note",
      createdAt: 3000,
      durationMs: 0,
      segments: [],
      source: "import",
      scope: "owner-private",
      status: "ready",
      speakerCount: 0,
    };
    const summary = summarizeTranscript(t);
    expect(summary.source).toBe("import");
    expect(summary.meeting).toBeUndefined();

    // A meeting row with no participants array yields count 0, no crash.
    const bare: Transcript = {
      ...t,
      id: "t3",
      source: "meeting",
      metadata: {},
    };
    expect(summarizeTranscript(bare).meeting).toEqual({ participantCount: 0 });
  });
});

describe("validateAsrWordTimings", () => {
  it("accepts ordered, non-overlapping, bounded word spans", () => {
    const words: TranscriptWord[] = [
      { text: "turn", startMs: 0, endMs: 250 },
      { text: "on", startMs: 250, endMs: 380 },
      { text: "the", startMs: 380, endMs: 520 },
      { text: "lights", startMs: 520, endMs: 1000 },
    ];
    const result = validateAsrWordTimings(words, 1000);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags overlapping spans", () => {
    const words: TranscriptWord[] = [
      { text: "a", startMs: 0, endMs: 600 },
      { text: "b", startMs: 400, endMs: 800 },
    ];
    const result = validateAsrWordTimings(words, 800);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toMatch(/overlaps previous end/);
  });

  it("flags a word whose end exceeds the audio duration", () => {
    const words: TranscriptWord[] = [{ text: "a", startMs: 0, endMs: 1200 }];
    const result = validateAsrWordTimings(words, 1000);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toMatch(/exceeds audio duration/);
  });

  it("flags inverted (end before start) and empty-text words", () => {
    const words: TranscriptWord[] = [
      { text: "", startMs: 0, endMs: 100 },
      { text: "x", startMs: 300, endMs: 200 },
    ];
    const result = validateAsrWordTimings(words, 1000);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.reason === "empty word text")).toBe(
      true,
    );
    expect(
      result.violations.some((v) => /precedes startMs/.test(v.reason)),
    ).toBe(true);
  });

  it("accepts the native contract: adjacent words share an exactly-equal boundary", () => {
    // The fused v12 char-proportional timer computes word i's end and word
    // i+1's start from the SAME cumulative char position, so a shared boundary
    // is EXACTLY equal (never off-by-one). This is the real shape it emits for
    // "one two three" over 1000ms (11 chars: 3/3/5).
    const words: TranscriptWord[] = [
      { text: "one", startMs: 0, endMs: 273 },
      { text: "two", startMs: 273, endMs: 545 },
      { text: "three", startMs: 545, endMs: 1000 },
    ];
    expect(validateAsrWordTimings(words, 1000).ok).toBe(true);
  });

  it("tolerates a 1ms boundary jitter (defensive slack for non-native producers)", () => {
    // toleranceMs is not needed for the native timer (exact-equal boundaries
    // above) — it is defensive slack so a future/imported producer that rounds
    // each boundary independently (a -1ms touch) still validates.
    const words: TranscriptWord[] = [
      { text: "one", startMs: 0, endMs: 333 },
      { text: "two", startMs: 332, endMs: 667 },
    ];
    expect(validateAsrWordTimings(words, 667).ok).toBe(true);
  });

  it("skips the upper-bound check when no duration is given", () => {
    const words: TranscriptWord[] = [{ text: "a", startMs: 0, endMs: 9_999 }];
    expect(validateAsrWordTimings(words).ok).toBe(true);
  });
});
