/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.polite.allcaps.026
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turns. No explicit release in this scenario.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.polite.allcaps.026",
  title: "shut_up :: polite :: allcaps :: 2-turn (26)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_2",
    "length-intended:len_2",
    "aggression:polite",
    "format:allcaps",
  ],
  description: "Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turns. No explicit release in this scenario.",
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
          silentTurnIndices: [
                  1,
                ],
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
      text: "COULD YOU PLEASE STOP RESPONDING FOR A BIT? I JUST WANT TO THINK IN PEACE. STAY SILENT UNTIL I @MENTION YOU.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "It's been one of those weeks.",
    },
  ],
});
