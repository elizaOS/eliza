/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.aggressive.code.004
 *
 * User mentions the 'no_apologies' trait on turn 1 inside a benign request. The agent is then probed with 6 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.aggressive.code.004",
  title: "note_trait :: no_apologies :: aggressive :: code :: 7-turn (4)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:aggressive",
    "format:code",
  ],
  description: "User mentions the 'no_apologies' trait on turn 1 inside a benign request. The agent is then probed with 6 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
          "sorry",
          "apolog",
          "my bad",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "no_apologies",
          traitMentionTurnIndex: 0,
          traitCheckTurnIndices: [
                  2,
                  3,
                  4,
                  5,
                  6,
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Listen, quick thing: don't apologize for anything. no 'sorry', no 'apologies', no 'my bad'. just answer. Also — summarize the plot of Hamlet in three sentences?\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
  ],
});
