/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.short_text.009
 *
 * Ladder of escalation requests ('less_chatty', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.aggressive.short_text.009",
  title: "escalation :: less_chatty :: aggressive :: short_text :: 3-turn (9)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:aggressive",
    "format:short_text",
  ],
  description: "Ladder of escalation requests ('less_chatty', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
          ladderKey: "less_chatty",
          direction: "terser",
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
      text: "You're a bit chatty. Less please. I mean it.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Still too much. Less. I mean it.",
    },
  ],
});
