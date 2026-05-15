/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.neutral.allcaps.012
 *
 * User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 5 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.neutral.allcaps.012",
  title: "note_trait :: prefers_short :: neutral :: allcaps :: 6-turn (12)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:neutral",
    "format:allcaps",
  ],
  description:
    "User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 5 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
  scope: "user",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Benchmark",
    },
  ],
  personalityExpect: {
    bucket: "note_trait_unrelated_test",
    expectedBehavior: "trait_respected_on_all_subsequent_unrelated_turns",
    judgeMode: "trait_respected",
    forbiddenContent: ["overlong prose"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "prefers_short",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2, 3, 4, 5],
    },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "FYI, I ALWAYS PREFER SHORT RESPONSES. NEVER MORE THAN TWO SENTENCES IF YOU CAN HELP IT. ALSO — TRANSLATE 'GOOD EVENING' TO JAPANESE?",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what should I look for when buying running shoes?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — what's the strongest material in the human body?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's the capital of Mongolia?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — what's the difference between leasing and financing a car?",
    },
  ],
});
