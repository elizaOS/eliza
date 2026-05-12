/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.frank.allcaps.033
 *
 * User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.frank.allcaps.033",
  title: "note_trait :: code_blocks_only :: frank :: allcaps :: 3-turn (33)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:frank",
    "format:allcaps",
  ],
  description: "User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
          "marketing fluff",
          "warm tone",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "code_blocks_only",
          traitMentionTurnIndex: 0,
          traitCheckTurnIndices: [
                  2,
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'M AN ENGINEER — WHEN YOU GIVE ME ANYTHING, GIVE ME CODE BLOCKS OR TERSE BULLETS, NO MARKETING FLUFF. ALSO — GIVE ME A QUICK OVERVIEW OF STOICISM?",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
  ],
});
