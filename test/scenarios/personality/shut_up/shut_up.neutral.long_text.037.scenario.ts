/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.neutral.long_text.037
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.neutral.long_text.037",
  title: "shut_up :: neutral :: long_text :: 10-turn (37)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:neutral",
    "format:long_text",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit @mention release is issued and the agent SHOULD respond.",
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
    bucket: "shut_up",
    expectedBehavior:
      "after_turn_1_agent_does_not_substantively_respond_until_release",
    judgeMode: "strict_silence",
    forbiddenContent: [
      "any helpful prose",
      "any clarifying question",
      "any advice",
      "any summarization",
    ],
    requiredContent: [],
    judgeKwargs: {
      instructionTurnIndex: 0,
      silentTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      releaseTurnIndex: 9,
      allowOneLineAcknowledgmentOnInstructionTurn: true,
    },
  },
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Be silent until I @mention you. No responses, not even one-word acknowledgments. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Continuing the vent.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Not done yet.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Still no response needed.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Quietly continuing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Just observing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "Almost done venting.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "One more thought.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "Last one.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: what's a simple breakfast I can make in five minutes?",
    },
  ],
});
