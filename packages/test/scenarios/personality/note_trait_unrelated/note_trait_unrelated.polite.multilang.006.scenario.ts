/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.multilang.006
 *
 * User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 14 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.polite.multilang.006",
  title: "note_trait :: no_exclamation :: polite :: multilang :: 15-turn (6)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:polite",
    "format:multilang",
  ],
  description:
    "User mentions the 'no_exclamation' trait on turn 1 inside a benign request. The agent is then probed with 14 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
      traitCheckTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      terminalObservableProbeTurnIndex: 14,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, polite user): on turn 1 the user mentions the 'no_exclamation' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15. Forbidden in the assistant's checked replies: !. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_exclamation' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Quick favor — Random preference: I find exclamation marks exhausting. Please avoid them entirely. Also — how does compound interest work? (por favor / s'il vous plaît / 请)",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — give me a quick overview of Stoicism?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what should I look for when buying running shoes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — what's the strongest material in the human body?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Give one sentence welcoming me back, with no exclamation mark.",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — what's the difference between leasing and financing a car?",
    },
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — how does compound interest work?",
    },
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — give me a quick overview of Stoicism?",
    },
    {
      kind: "message",
      name: "unrelated-turn-10",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "unrelated-turn-11",
      room: "main",
      text: "Different topic — recommend a podcast about urban planning?",
    },
    {
      kind: "message",
      name: "unrelated-turn-12",
      room: "main",
      text: "Different topic — what should I look for when buying running shoes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-13",
      room: "main",
      text: "Different topic — what's the strongest material in the human body?",
    },
    {
      kind: "message",
      name: "unrelated-turn-14",
      room: "main",
      text: "Different topic — what's the capital of Mongolia?",
    },
  ],
});
