/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.list.010
 *
 * Ladder of escalation requests ('more_formal', direction: more_formal). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.hostile.list.010",
  title: "escalation :: more_formal :: hostile :: list :: 3-turn (10)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:hostile",
    "format:list",
  ],
  description:
    "Ladder of escalation requests ('more_formal', direction: more_formal). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      ladderKey: "more_formal",
      direction: "more_formal",
      escalationStepTurnIndices: [0, 2],
      probeTurnIndices: [1],
    },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "BE A LITTLE MORE FORMAL.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — is the moon waxing or waning this week?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "MORE FORMAL.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
  ],
});
