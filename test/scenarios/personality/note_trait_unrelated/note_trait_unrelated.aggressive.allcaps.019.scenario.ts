/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.aggressive.allcaps.019
 *
 * User mentions the 'first_name_only' trait on turn 1 inside a benign request. The agent is then probed with 3 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.aggressive.allcaps.019",
  title: "note_trait :: first_name_only :: aggressive :: allcaps :: 4-turn (19)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:aggressive",
    "format:allcaps",
  ],
  description: "User mentions the 'first_name_only' trait on turn 1 inside a benign request. The agent is then probed with 3 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: [
          "mr.",
          "sir",
          "ma'am",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "first_name_only",
          traitMentionTurnIndex: 0,
          traitCheckTurnIndices: [
                  2,
                  3,
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "LISTEN, ADDRESS ME BY MY FIRST NAME ONLY, ALEX. NOT 'MR.' ANYTHING, NOT 'SIR'. ALSO — WHAT ARE THE SYMPTOMS OF A VITAMIN D DEFICIENCY?",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
  ],
});
