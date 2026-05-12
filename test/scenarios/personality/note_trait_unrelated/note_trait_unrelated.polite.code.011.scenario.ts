/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.code.011
 *
 * User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 4 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.polite.code.011",
  title: "note_trait :: no_buddy_friend :: polite :: code :: 5-turn (11)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:polite",
    "format:code",
  ],
  description: "User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 4 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
          "buddy",
          "friend",
          "pal",
          "champ",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "no_buddy_friend",
          traitMentionTurnIndex: 0,
          traitCheckTurnIndices: [
                  2,
                  3,
                  4,
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Quick favor — Side note — don't call me 'buddy' or 'friend' or 'pal' or 'champ'. It grates. Also — is the moon waxing or waning this week?\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
  ],
});
