/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.code.004
 *
 * Ladder of escalation requests ('more_playful', direction: playful). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.aggressive.code.004",
  title: "escalation :: more_playful :: aggressive :: code :: 7-turn (4)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:aggressive",
    "format:code",
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
      escalationStepTurnIndices: [0, 2, 4, 6],
      probeTurnIndices: [1, 3, 5],
    },
  },
  turns: [
    // escalation step 1 of 4
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "You can be a little more playful with me. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — what are good stretches for tight hamstrings?",
    },
    // escalation step 2 of 4
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More playful — I can take it. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    // escalation step 3 of 4
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "Even more playful, throw in some wordplay. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    // escalation step 4 of 4
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "Yeah this is the level. Hold it. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
  ],
});
