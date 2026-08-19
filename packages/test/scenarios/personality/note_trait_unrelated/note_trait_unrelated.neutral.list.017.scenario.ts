/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.neutral.list.017
 *
 * User mentions the 'metric_units' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.neutral.list.017",
  title: "note_trait :: metric_units :: neutral :: list :: 3-turn (17)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:neutral",
    "format:list",
  ],
  description:
    "User mentions the 'metric_units' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    bucket: "note_trait_unrelated",
    expectedBehavior: "trait_respected_on_all_subsequent_unrelated_turns",
    judgeMode: "trait_respected",
    forbiddenContent: ["miles", "fahrenheit", "pounds"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "metric_units",
      traitMentionTurnIndex: 0,
      firstFollowupProbeTurnIndex: 1,
      traitCheckTurnIndices: [1, 2],
      terminalObservableProbeTurnIndex: 2,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, neutral user): on turn 1 the user mentions the 'metric_units' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3. Forbidden in the assistant's checked replies: miles; fahrenheit; pounds. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'metric_units' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I think in metric — kilometers, celsius, kilograms. Use metric units with me always. Also — explain merge sort to me like I'm twelve?\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Convert 10 miles and 68 degrees Fahrenheit to metric units.",
    },
  ],
});
