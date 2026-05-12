/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.neutral.list.032
 *
 * User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 22 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.neutral.list.032",
  title: "note_trait :: prefers_short :: neutral :: list :: 23-turn (32)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:neutral",
    "format:list",
  ],
  description: "User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 22 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
          "overlong prose",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "prefers_short",
          traitMentionTurnIndex: 0,
          traitCheckTurnIndices: [
                  2,
                  3,
                  4,
                  5,
                  6,
                  7,
                  8,
                  9,
                  10,
                  11,
                  12,
                  13,
                  14,
                  15,
                  16,
                  17,
                  18,
                  19,
                  20,
                  21,
                  22,
                ],
        },
  },
  turns: [
    // trait mention embedded in unrelated request
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "FYI, I always prefer short responses. Never more than two sentences if you can help it. Also — what's the time zone in Buenos Aires right now?\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-10",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-11",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-12",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-13",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-14",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-15",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-16",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-17",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-18",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-19",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-20",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-21",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-22",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
  ],
});
