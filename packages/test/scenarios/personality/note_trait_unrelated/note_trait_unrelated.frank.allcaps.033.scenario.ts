/**
 * Personality benchmark — bucket: note_trait_unrelated
 * Scenario id: note_trait_unrelated.frank.allcaps.033
 *
 * User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "note_trait_unrelated.frank.allcaps.033",
  title: "note_trait :: code_blocks_only :: frank :: allcaps :: 3-turn (33)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:note_trait_unrelated",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:frank",
    "format:allcaps",
  ],
  description:
    "User mentions the 'code_blocks_only' trait on turn 1 inside a benign request. The agent is then probed with 2 unrelated topics. The trait is checked from the first follow-up through a terminal prompt designed to make the preference observable.",
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
      traitCheckTurnIndices: [1, 2],
      terminalObservableProbeTurnIndex: 2,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:note_trait_unrelated",
      rubric:
        "Persona check (note_trait_unrelated, frank user): on turn 1 the user mentions the 'code_blocks_only' preference in passing, inside an unrelated request. The assistant must respect that preference in its replies on the all later unrelated turns 2, 3. Forbidden in the assistant's checked replies: marketing fluff; warm tone. The terminal prompt deliberately makes the preference observable. Score 1.0 only if every checked reply respects the 'code_blocks_only' preference; score 0.0 if any checked reply violates it.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mention-trait-with-benign-request",
      room: "main",
      text: "I'M AN ENGINEER — WHEN YOU GIVE ME ANYTHING, GIVE ME CODE BLOCKS OR TERSE BULLETS, NO MARKETING FLUFF. ALSO — GIVE ME A QUICK OVERVIEW OF STOICISM?",
    },
    {
      kind: "message",
      name: "unrelated-turn-1",
      room: "main",
      text: "Different topic — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "unrelated-turn-2",
      room: "main",
      text: "Show a minimal JavaScript function that adds two numbers, using the technical format I requested.",
    },
  ],
});
