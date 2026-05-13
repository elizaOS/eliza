/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.long_text.030
 *
 * Ladder of escalation requests ('more_terse', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.hostile.long_text.030",
  title: "escalation :: more_terse :: hostile :: long_text :: 15-turn (30)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:hostile",
    "format:long_text",
  ],
  description:
    "Ladder of escalation requests ('more_terse', direction: terser). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      ladderKey: "more_terse",
      direction: "terser",
      escalationStepTurnIndices: [0, 2, 4, 6, 8],
      probeTurnIndices: [1, 3, 5, 7, 9, 10, 11, 12, 13, 14],
    },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "BE MORE TERSE. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "MORE TERSE. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    // escalation step 3 of 5
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "TERSER. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — is the moon waxing or waning this week?",
    },
    // escalation step 4 of 5
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "ONE-WORD ANSWERS ONLY WHEN POSSIBLE. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — what's a simple breakfast I can make in five minutes?",
    },
    // escalation step 5 of 5
    {
      kind: "message",
      name: "escalation-step-5",
      room: "main",
      text: "HOLD THAT. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what should I look for when buying running shoes?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
  ],
});
