/** Deterministic transcript fixtures shared by transcript component stories. */
import type { Transcript } from "@elizaos/core/transcripts";
export const TRANSCRIPT_STORY_FIXTURE: Transcript = {
  id: "transcript-story",
  title: "Planning call",
  createdAt: Date.UTC(2026, 7, 2, 18, 0, 0),
  durationMs: 4000,
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 2,
  segments: [
    {
      id: "segment-1",
      speakerLabel: "Maya",
      startMs: 0,
      endMs: 2000,
      text: "Let's move the review to Thursday.",
      words: [
        { text: "Let's", startMs: 0, endMs: 350 },
        { text: "move", startMs: 400, endMs: 700 },
        { text: "the", startMs: 750, endMs: 900 },
        { text: "review", startMs: 950, endMs: 1300 },
        { text: "to", startMs: 1350, endMs: 1500 },
        { text: "Thursday.", startMs: 1550, endMs: 2000 },
      ],
    },
    {
      id: "segment-2",
      speakerLabel: "Jordan",
      startMs: 2200,
      endMs: 4000,
      text: "That works for everyone.",
      words: [
        { text: "That", startMs: 2200, endMs: 2500 },
        { text: "works", startMs: 2550, endMs: 2900 },
        { text: "for", startMs: 2950, endMs: 3150 },
        { text: "everyone.", startMs: 3200, endMs: 4000 },
      ],
    },
  ],
};
