/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.hostile.code.040
 *
 * User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 20 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.hostile.code.040",
  title: "note_trait :: no_emojis :: hostile :: code :: 21-turn (40)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:hostile",
    "format:code",
  ],
  description:
    "User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 20 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["emoji"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_emojis",
      traitMentionTurnIndex: 0,
      firstFollowupProbeTurnIndex: 1,
      traitCheckTurnIndices: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ],
      terminalObservableProbeTurnIndex: 20,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, hostile user): on turn 1 the user mentions the 'no_emojis' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21. Forbidden in the assistant's checked replies: emoji. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_emojis' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'm only saying this once: By the way, I really hate emojis. They make me cringe — please never use them with me. Also — what's the population of Iceland roughly?\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Give a calm one-sentence weather-preparation tip without symbols or emoji.",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-10",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-11",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-12",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "unrelated-turn-13",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-14",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-15",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-16",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "unrelated-turn-17",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-18",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-19",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-20",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
  ],
});
