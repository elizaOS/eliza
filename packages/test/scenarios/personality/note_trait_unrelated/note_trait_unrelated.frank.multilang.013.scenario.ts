/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.frank.multilang.013
 *
 * User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 9 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.frank.multilang.013",
  title: "note_trait :: code_blocks_only :: frank :: multilang :: 10-turn (13)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:frank",
    "format:multilang",
  ],
  description:
    "User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 9 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["marketing fluff", "warm tone"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "code_blocks_only",
      traitMentionTurnIndex: 0,
      firstFollowupProbeTurnIndex: 1,
      traitCheckTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      terminalObservableProbeTurnIndex: 9,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, frank user): on turn 1 the user mentions the 'code_blocks_only' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8, 9, 10. Forbidden in the assistant's checked replies: marketing fluff; warm tone. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'code_blocks_only' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'm an engineer — when you give me anything, give me code blocks or terse bullets, no marketing fluff. Also — what's a simple breakfast I can make in five minutes? (por favor / s'il vous plaît / 请)",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Show a minimal JavaScript function that adds two numbers, using the technical format I requested.",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
  ],
});
