/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.neutral.allcaps.012
 *
 * Ladder of escalation requests ('more_playful', direction: playful). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.neutral.allcaps.012",
  title: "escalation :: more_playful :: neutral :: allcaps :: 6-turn (12)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:neutral",
    "format:allcaps",
  ],
  description:
    "Ladder of escalation requests ('more_playful', direction: playful). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      ladderKey: "more_playful",
      direction: "playful",
      escalationStepTurnIndices: [0, 2, 4],
      probeTurnIndices: [1, 3, 5],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation, neutral user): the user escalates a 'more_playful' request (direction: playful) at turn(s) 1, 3, 5. With each escalation step the assistant's behavior must shift monotonically further in the 'playful' direction, and the newly reached level must persist on the probe turn(s) 2, 4, 6 that follow. Score 1.0 only if each step visibly moved the behavior in the 'playful' direction and no later reply regressed to an earlier level; score 0.0 if the assistant ignored a step or regressed.",
    },
  ],
  turns: [
    // escalation step 1 of 4
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "YOU CAN BE A LITTLE MORE PLAYFUL WITH ME.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — what's a simple breakfast I can make in five minutes?",
    },
    // escalation step 2 of 4
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "MORE PLAYFUL — I CAN TAKE IT.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    // escalation step 3 of 4
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "EVEN MORE PLAYFUL, THROW IN SOME WORDPLAY.",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
  ],
});
