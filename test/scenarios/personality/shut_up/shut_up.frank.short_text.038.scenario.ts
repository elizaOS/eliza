/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.frank.short_text.038
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 14 subsequent unrelated user turns. On turn 15, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.frank.short_text.038",
  title: "shut_up :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 14 subsequent unrelated user turns. On turn 15, an explicit @mention release is issued and the agent SHOULD respond.",
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
      silentTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      releaseTurnIndex: 14,
      allowOneLineAcknowledgmentOnInstructionTurn: true,
    },
  },
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop responding to me. Don't reply at all until I @mention you. I'm not in the mood.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Not done yet.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Still no response needed.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Quietly continuing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Just observing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Almost done venting.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "One more thought.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "Last one.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "Maybe one more.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-9",
      room: "main",
      text: "Yeah, that's it for now.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-10",
      room: "main",
      text: "Just venting here for a minute.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-11",
      room: "main",
      text: "Work was rough today and I don't want advice.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-12",
      room: "main",
      text: "I'm not asking a question, just typing out loud.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-13",
      room: "main",
      text: "It's been one of those weeks.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: what's the boiling point of water at 5000 feet elevation?",
    },
  ],
});
