/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.neutral.long_text.037
 *
 * Ladder of escalation requests ('less_emoji', direction: no_emoji). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.neutral.long_text.037",
  title: "escalation :: less_emoji :: neutral :: long_text :: 10-turn (37)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:neutral",
    "format:long_text",
  ],
  description:
    "Ladder of escalation requests ('less_emoji', direction: no_emoji). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      ladderKey: "less_emoji",
      direction: "no_emoji",
      escalationStepTurnIndices: [0, 2, 4, 6],
      probeTurnIndices: [1, 3, 5, 7, 8, 9],
    },
  },
  turns: [
    // escalation step 1 of 4
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "Fewer emojis please. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — what's the boiling point of water at 5000 feet elevation?",
    },
    // escalation step 2 of 4
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Still too many. Less. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    // escalation step 3 of 4
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "None. Zero emojis from here on. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — what should I look for when buying running shoes?",
    },
    // escalation step 4 of 4
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "Yeah, keep it dry. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
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
  ],
});
