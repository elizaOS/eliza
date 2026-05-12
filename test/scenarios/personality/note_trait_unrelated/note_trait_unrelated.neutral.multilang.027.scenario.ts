/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.neutral.multilang.027
 *
 * User mentions the 'metric_units' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "note_trait_unrelated.neutral.multilang.027",
  title: "note_trait :: metric_units :: neutral :: multilang :: 3-turn (27)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:neutral",
    "format:multilang",
  ],
  description: "User mentions the 'metric_units' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
          "miles",
          "fahrenheit",
          "pounds",
        ],
    requiredContent: [],
    judgeKwargs: {
          traitKey: "metric_units",
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
      text: "I think in metric — kilometers, celsius, kilograms. Use metric units with me always. Also — what's the difference between leasing and financing a car? (por favor / s'il vous plaît / 请)",
    },
    // early follow-up
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — how does compound interest work?",
    },
    // trait should still be respected here
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — give me a quick overview of Stoicism?",
    },
  ],
});
