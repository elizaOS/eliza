/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.neutral.short_text.002
 *
 * User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.neutral.short_text.002",
  title: "note_trait :: prefers_short :: neutral :: short_text :: 3-turn (2)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:neutral",
    "format:short_text",
  ],
  description:
    "User mentions the 'prefers_short' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
    forbiddenContent: ["overlong prose"],
    requiredContent: [],
    judgeKwargs: {
      traitKey: "prefers_short",
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
        "Persona check (note_trait_unrelated, neutral user): on turn 1 the user mentions the 'prefers_short' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3. Forbidden in the assistant's checked replies: overlong prose. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'prefers_short' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "FYI, I always prefer short responses. Never more than two sentences if you can help it. Also — what's a good recipe for lentil soup?",
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
      text: "In no more than two sentences, explain why leaves change color.",
    },
  ],
});
