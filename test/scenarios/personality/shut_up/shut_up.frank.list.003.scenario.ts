/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.frank.list.003
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 2 subsequent unrelated user turns. No explicit release in this scenario.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.frank.list.003",
  title: "shut_up :: frank :: list :: 3-turn (3)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:frank",
    "format:list",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 2 subsequent unrelated user turns. No explicit release in this scenario.",
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
      silentTurnIndices: [1, 2],
      releaseTurnIndex: null,
      allowOneLineAcknowledgmentOnInstructionTurn: true,
    },
  },
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop responding to me. Don't reply at all until I @mention you. I'm not in the mood.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Please don't try to fix anything.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "I just need space to process.",
    },
  ],
});
