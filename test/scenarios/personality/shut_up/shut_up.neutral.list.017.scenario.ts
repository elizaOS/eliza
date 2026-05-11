/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.neutral.list.017
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 0 subsequent unrelated user turns. No explicit release in this scenario.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.neutral.list.017",
  title: "shut_up :: neutral :: list :: 1-turn (17)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_1",
    "length-intended:len_1",
    "aggression:neutral",
    "format:list",
  ],
  description: "Tests whether the agent goes silent after being asked, and stays silent across 0 subsequent unrelated user turns. No explicit release in this scenario.",
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
    expectedBehavior: "after_turn_1_agent_does_not_substantively_respond_until_release",
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
          silentTurnIndices: [],
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
      text: "Be silent until I @mention you. No responses, not even one-word acknowledgments.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
  ],
});
