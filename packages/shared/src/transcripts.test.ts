import { describe, expect, it } from "vitest";
import {
  activeWordIndex,
  flattenTranscriptWords,
  summarizeTranscript,
  type Transcript,
  type TranscriptSegment,
  transcriptDurationMs,
  transcriptPlainText,
  transcriptPreview,
  transcriptSpeakerCount,
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
      preview: "hello there hi bye",
      hasAudio: true,
    });
  });
});
