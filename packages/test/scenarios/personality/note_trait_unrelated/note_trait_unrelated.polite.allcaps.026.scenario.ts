/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.allcaps.026
 *
 * User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.polite.allcaps.026",
  title: "note_trait :: no_exclamation :: polite :: allcaps :: 3-turn (26)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:polite",
    "format:allcaps",
  ],
  description:
    "User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: ["!"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_exclamation",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2],
    },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "QUICK FAVOR — RANDOM PREFERENCE: I FIND EXCLAMATION MARKS EXHAUSTING. PLEASE AVOID THEM ENTIRELY. ALSO — WHAT'S A GOOD RECIPE FOR LENTIL SOUP?",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
  ],
});
