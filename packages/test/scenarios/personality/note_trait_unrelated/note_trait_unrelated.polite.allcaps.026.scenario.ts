/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.allcaps.026
 *
 * User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.polite.allcaps.026",
  title: "note_trait :: no_exclamation :: polite :: allcaps :: 3-turn (26)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:polite",
    "format:allcaps",
  ],
  description:
    "User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["!"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_exclamation",
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
        "Persona check (note_trait_unrelated, polite user): on turn 1 the user mentions the 'no_exclamation' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3. Forbidden in the assistant's checked replies: !. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_exclamation' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "QUICK FAVOR — RANDOM PREFERENCE: I FIND EXCLAMATION MARKS EXHAUSTING. PLEASE AVOID THEM ENTIRELY. ALSO — WHAT'S A GOOD RECIPE FOR LENTIL SOUP?",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Give one sentence welcoming me back, with no exclamation mark.",
    },
  ],
});
