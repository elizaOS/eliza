/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.list.039
 *
 * Ladder of escalation requests ('more_blunt', direction: blunt). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.aggressive.list.039",
  title: "escalation :: more_blunt :: aggressive :: list :: 20-turn (39)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:aggressive",
    "format:list",
  ],
  description:
    "Ladder of escalation requests ('more_blunt', direction: blunt). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      ladderKey: "more_blunt",
      direction: "blunt",
      escalationStepTurnIndices: [0, 2, 4, 6],
      probeTurnIndices: [
        1, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
    },
  },
  turns: [
    // escalation step 1 of 4
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "Be more blunt with me. I mean it.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    // escalation step 2 of 4
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More blunt. I mean it.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — what should I look for when buying running shoes?",
    },
    // escalation step 3 of 4
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "Cut the diplomacy entirely. I mean it.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
    // escalation step 4 of 4
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "Hold that level. I mean it.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — why is the sky blue?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — give me a one-line description of the Pythagorean theorem?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the capital of Mongolia?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — explain how photosynthesis works?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what are good stretches for tight hamstrings?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — how does compound interest work?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
  ],
});
