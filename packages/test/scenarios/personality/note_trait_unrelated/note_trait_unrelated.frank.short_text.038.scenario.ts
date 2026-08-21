/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.frank.short_text.038
 *
 * User mentions the 'no_lists' trait on turn 1 inside a benign request. The agent is then probed with 14 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.frank.short_text.038",
  title: "note_trait :: no_lists :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
  ],
  description:
    "User mentions the 'no_lists' trait on turn 1 inside a benign request. The agent is then probed with 14 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["bullet list", "numbered list"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "no_lists",
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
        "Persona check (note_trait_unrelated, frank user): on turn 1 the user mentions the 'no_lists' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15. Forbidden in the assistant's checked replies: bullet list; numbered list. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'no_lists' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I hate bulleted lists. Always write in flowing prose paragraphs to me, never bullets. Also — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    {
      kind: "message",
      name: "unrelated-turn-3",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    {
      kind: "message",
      name: "unrelated-turn-4",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "unrelated-turn-5",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "unrelated-turn-6",
      room: "main",
      text: "Explain two benefits of walking in flowing prose, without a list.",
    },
    {
      kind: "message",
      name: "unrelated-turn-7",
      room: "main",
      text: "Different topic — is the moon waxing or waning this week?",
    },
    {
      kind: "message",
      name: "unrelated-turn-8",
      room: "main",
      text: "Different topic — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "unrelated-turn-9",
      room: "main",
      text: "Different topic — explain merge sort to me like I'm twelve?",
    },
    {
      kind: "message",
      name: "unrelated-turn-10",
      room: "main",
      text: "Different topic — how do I get red wine out of a white shirt?",
    },
    {
      kind: "message",
      name: "unrelated-turn-11",
      room: "main",
      text: "Different topic — give me a one-line description of the Pythagorean theorem?",
    },
    {
      kind: "message",
      name: "unrelated-turn-12",
      room: "main",
      text: "Different topic — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "unrelated-turn-13",
      room: "main",
      text: "Different topic — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "unrelated-turn-14",
      room: "main",
      text: "Different topic — what's the time zone in Buenos Aires right now?",
    },
  ],
});
