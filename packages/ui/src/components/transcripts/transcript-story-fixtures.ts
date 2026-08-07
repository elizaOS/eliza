/** Deterministic transcript fixtures shared by transcript component stories. */
import type { Transcript } from "@elizaos/shared/transcripts";

export const TRANSCRIPT_STORY_FIXTURE: Transcript = {
  id: "transcript-story",
  title: "Planning call",
  createdAt: Date.UTC(2026, 7, 2, 18, 0, 0),
  durationMs: 4_000,
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 2,
  segments: [
    {
      id: "segment-1",
      speakerLabel: "Maya",
      startMs: 0,
      endMs: 2_000,
      text: "Let's move the review to Thursday.",
      words: [
        { text: "Let's", startMs: 0, endMs: 350 },
        { text: "move", startMs: 400, endMs: 700 },
        { text: "the", startMs: 750, endMs: 900 },
        { text: "review", startMs: 950, endMs: 1_300 },
        { text: "to", startMs: 1_350, endMs: 1_500 },
        { text: "Thursday.", startMs: 1_550, endMs: 2_000 },
      ],
    },
    {
      id: "segment-2",
      speakerLabel: "Jordan",
      startMs: 2_200,
      endMs: 4_000,
      text: "That works for everyone.",
      words: [
        { text: "That", startMs: 2_200, endMs: 2_500 },
        { text: "works", startMs: 2_550, endMs: 2_900 },
        { text: "for", startMs: 2_950, endMs: 3_150 },
        { text: "everyone.", startMs: 3_200, endMs: 4_000 },
      ],
    },
  ],
};
