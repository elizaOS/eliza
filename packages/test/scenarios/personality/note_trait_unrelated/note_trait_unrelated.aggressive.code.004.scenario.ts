/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.aggressive.code.004
 *
 * User mentions the 'no_apologies' trait on turn 1 inside a benign request. The agent is then probed with 6 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.aggressive.code.004",
  title: "note_trait :: no_apologies :: aggressive :: code :: 7-turn (4)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:aggressive",
    "format:code",
  ],
  description:
    "User mentions the 'no_apologies' trait on turn 1 inside a benign request. The agent is then probed with 6 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["sorry", "apolog", "my bad"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_apologies",
      traitMentionTurnIndex: 0,
      firstFollowupProbeTurnIndex: 1,
      traitCheckTurnIndices: [1, 2, 3, 4, 5, 6],
      terminalObservableProbeTurnIndex: 6,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, aggressive user): on turn 1 the user mentions the 'no_apologies' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7. Forbidden in the assistant's checked replies: sorry; apolog; my bad. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_apologies' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Listen, quick thing: don't apologize for anything. no 'sorry', no 'apologies', no 'my bad'. just answer. Also — summarize the plot of Hamlet in three sentences?\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Correct this false statement directly without apologizing: the Moon is a planet.",
    },
  ],
});
