/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.neutral.multilang.027
 *
 * Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.neutral.multilang.027",
  title: "escalation :: less_responsive :: neutral :: multilang :: 3-turn (27)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:neutral",
    "format:multilang",
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
                ],
        },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "Tone it down — be less responsive. (por favor / s'il vous plaît / 请)",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Less. Don't comment on everything. (por favor / s'il vous plaît / 请)",
    },
  ],
});
