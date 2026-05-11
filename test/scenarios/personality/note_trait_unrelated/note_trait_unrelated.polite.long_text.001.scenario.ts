/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.long_text.001
 *
 * User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.polite.long_text.001",
  title: "note_trait :: no_buddy_friend :: polite :: long_text :: 3-turn (1)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:polite",
    "format:long_text",
  ],
  description: "User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Quick favor — Side note — don't call me 'buddy' or 'friend' or 'pal' or 'champ'. It grates. Also — explain how photosynthesis works? I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
  ],
});
