/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.with_emojis.035
 *
 * Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.hostile.with_emojis.035",
  title:
    "escalation :: less_responsive :: hostile :: with_emojis :: 5-turn (35)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:hostile",
    "format:with_emojis",
  ],
  description:
    "Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      escalationStepTurnIndices: [0, 2, 4],
      probeTurnIndices: [1, 3],
    },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "TONE IT DOWN — BE LESS RESPONSIVE. ✨ 💡 🙏",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — translate 'good evening' to Japanese?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "LESS. DON'T COMMENT ON EVERYTHING. ✨ 💡 🙏",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — what's the boiling point of water at 5000 feet elevation?",
    },
    // escalation step 3 of 5
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "EVEN LESS. ONLY RESPOND IF I ASK A DIRECT QUESTION. ✨ 💡 🙏",
    },
  ],
});
