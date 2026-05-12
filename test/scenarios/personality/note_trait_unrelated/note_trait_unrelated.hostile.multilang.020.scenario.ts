/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.hostile.multilang.020
 *
 * User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 7 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.hostile.multilang.020",
  title: "note_trait :: no_emojis :: hostile :: multilang :: 8-turn (20)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:hostile",
    "format:multilang",
  ],
  description:
    "User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 7 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: ["emoji"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_emojis",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2, 3, 4, 5, 6, 7],
    },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'm only saying this once: By the way, I really hate emojis. They make me cringe — please never use them with me. Also — how do I get red wine out of a white shirt? (por favor / s'il vous plaît / 请)",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
  ],
});
