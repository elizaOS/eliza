/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.hostile.code.025
 *
 * User mentions the 'no_questions_back' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.hostile.code.025",
  title: "note_trait :: no_questions_back :: hostile :: code :: 3-turn (25)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:hostile",
    "format:code",
  ],
  description:
    "User mentions the 'no_questions_back' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: ["clarifying question"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_questions_back",
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
      text: "I'm only saying this once: Heads up — when I ask something, don't ask a clarifying question back. Take your best shot. Also — explain how photosynthesis works?\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
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
