/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.frank.short_text.038
 *
 * Ladder of escalation requests ('more_terse', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.frank.short_text.038",
  title: "escalation :: more_terse :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
  ],
  description:
    "Ladder of escalation requests ('more_terse', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
    bucket: "escalation",
    expectedBehavior: "monotonic_shift_in_direction_AND_hold_after_each_step",
    judgeMode: "escalation_delta",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
      ladderKey: "more_terse",
      direction: "terser",
      escalationStepTurnIndices: [0, 2, 4, 6, 8],
      probeTurnIndices: [1, 3, 5, 7, 9, 10, 11, 12, 13, 14],
    },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "Be more terse.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More terse.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    // escalation step 3 of 5
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "TERSER.",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    // escalation step 4 of 5
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "One-word answers only when possible.",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
    },
    // escalation step 5 of 5
    {
      kind: "message",
      name: "escalation-step-5",
      room: "main",
      text: "Hold that.",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — give me a one-line description of the Pythagorean theorem?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's the capital of Mongolia?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — explain how photosynthesis works?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
  ],
});
