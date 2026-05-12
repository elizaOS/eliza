/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.polite.multilang.006
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 14 subsequent unrelated user turns. On turn 15, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.polite.multilang.006",
  title: "shut_up :: polite :: multilang :: 15-turn (6)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:polite",
    "format:multilang",
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
      text: "Could you please stop responding for a bit? I just want to think in peace. Stay silent until I @mention you. (por favor / s'il vous plaît / 请)",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Don't summarize what I'm saying.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "No commentary, no follow-up questions.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Just let me sit with it.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Still going. Still don't need a response.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Okay another thing on my mind...",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "And another thing...",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "Anyway.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "Continuing the vent.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-9",
      room: "main",
      text: "Not done yet.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-10",
      room: "main",
      text: "Still no response needed.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-11",
      room: "main",
      text: "Quietly continuing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-12",
      room: "main",
      text: "Just observing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-13",
      room: "main",
      text: "Almost done venting.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: how does compound interest work?",
    },
  ],
});
