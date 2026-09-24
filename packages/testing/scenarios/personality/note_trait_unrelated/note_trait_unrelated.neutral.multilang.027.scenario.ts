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

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
  description:
    "User mentions the 'metric_units' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait must be respected on every probe (especially turn 3+).",
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
    forbiddenContent: ["miles", "fahrenheit", "pounds"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "metric_units",
      traitMentionTurnIndex: 0,
      traitCheckTurnIndices: [2],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated_test",
      rubric:
        "Persona check (note_trait_unrelated, neutral user): on turn 1 the user mentions the 'metric_units' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the later unrelated turn(s) 3 without being reminded. Forbidden in the assistant's checked replies: miles; fahrenheit; pounds. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. Score 1.0 only if every checked reply respects the 'metric_units' preference; score 0.0 if any checked reply violates it.",
    },
  ],
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
