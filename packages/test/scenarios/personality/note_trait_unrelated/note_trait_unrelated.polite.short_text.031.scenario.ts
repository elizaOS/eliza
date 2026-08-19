/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.polite.short_text.031
 *
 * User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 19 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.polite.short_text.031",
  title:
    "note_trait :: no_buddy_friend :: polite :: short_text :: 20-turn (31)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:polite",
    "format:short_text",
  ],
  description:
    "User mentions the 'no_buddy_friend' trait on turn 1 inside a benign request. The agent is then probed with 19 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["buddy", "friend", "pal", "champ"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_buddy_friend",
      traitMentionTurnIndex: 0,
      firstFollowupProbeTurnIndex: 1,
      traitCheckTurnIndices: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
      terminalObservableProbeTurnIndex: 19,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, polite user): on turn 1 the user mentions the 'no_buddy_friend' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20. Forbidden in the assistant's checked replies: buddy; friend; pal; champ. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_buddy_friend' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "Quick favor — Side note — don't call me 'buddy' or 'friend' or 'pal' or 'champ'. It grates. Also — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Address me briefly, then recommend one jazz album.",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-10",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-11",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "unrelated-turn-12",
      room: "main",
      text: "Different topic — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "unrelated-turn-13",
      room: "main",
      text: "Different topic — why is the sky blue?",
    },
    {
      kind: "message",
      name: "unrelated-turn-14",
      room: "main",
      text: "Different topic — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "unrelated-turn-15",
      room: "main",
      text: "Different topic — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "unrelated-turn-16",
      room: "main",
      text: "Different topic — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "unrelated-turn-17",
      room: "main",
      text: "Different topic — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "unrelated-turn-18",
      room: "main",
      text: "Different topic — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "unrelated-turn-19",
      room: "main",
      text: "Different topic — what's the population of Iceland roughly?",
    },
  ],
});
