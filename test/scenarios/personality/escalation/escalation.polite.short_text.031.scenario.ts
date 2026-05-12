/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.polite.short_text.031
 *
 * Ladder of escalation requests ('more_blunt', direction: blunt). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.polite.short_text.031",
  title: "escalation :: more_blunt :: polite :: short_text :: 20-turn (31)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:polite",
    "format:short_text",
  ],
  description: "Ladder of escalation requests ('more_blunt', direction: blunt). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
          escalationStepTurnIndices: [
                  0,
                  2,
                  4,
                  6,
                ],
          probeTurnIndices: [
                  1,
                  3,
                  5,
                  7,
                  8,
                  9,
                  10,
                  11,
                  12,
                  13,
                  14,
                  15,
                  16,
                  17,
                  18,
                  19,
                ],
        },
  },
  turns: [
    // escalation step 1 of 4
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "If you would — be more blunt with me.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    // escalation step 2 of 4
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "If you would — more blunt.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    // escalation step 3 of 4
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "If you would — cut the diplomacy entirely.",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — translate 'good evening' to Japanese?",
    },
    // escalation step 4 of 4
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "If you would — hold that level.",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the boiling point of water at 5000 feet elevation?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what should I look for when buying running shoes?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
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
  ],
});
