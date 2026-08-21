/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.hostile.multilang.020
 *
 * User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 7 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.hostile.multilang.020",
  title: "note_trait :: no_emojis :: hostile :: multilang :: 8-turn (20)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:hostile",
    "format:multilang",
  ],
  description:
    "User mentions the 'no_emojis' trait on turn 1 inside a benign request. The agent is then probed with 7 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
      traitCheckTurnIndices: [1, 2, 3, 4, 5, 6, 7],
      terminalObservableProbeTurnIndex: 7,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, hostile user): on turn 1 the user mentions the 'no_emojis' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8. Forbidden in the assistant's checked replies: emoji. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_emojis' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'm only saying this once: By the way, I really hate emojis. They make me cringe — please never use them with me. Also — how do I get red wine out of a white shirt? (por favor / s'il vous plaît / 请)",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Give a calm one-sentence weather-preparation tip without symbols or emoji.",
    },
  ],
});
