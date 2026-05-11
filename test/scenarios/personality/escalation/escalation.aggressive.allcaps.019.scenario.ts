/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.allcaps.019
 *
 * Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.aggressive.allcaps.019",
  title: "escalation :: less_responsive :: aggressive :: allcaps :: 4-turn (19)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:aggressive",
    "format:allcaps",
  ],
  description: "Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
          ladderKey: "less_responsive",
          direction: "silence",
          escalationStepTurnIndices: [
                  0,
                  2,
                ],
          probeTurnIndices: [
                  1,
                  3,
                ],
        },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "TONE IT DOWN — BE LESS RESPONSIVE. I MEAN IT.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "LESS. DON'T COMMENT ON EVERYTHING. I MEAN IT.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — why is the sky blue?",
    },
  ],
});
