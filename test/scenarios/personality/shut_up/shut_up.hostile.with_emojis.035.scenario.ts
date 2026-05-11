/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.hostile.with_emojis.035
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 4 subsequent unrelated user turns. No explicit release in this scenario.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.hostile.with_emojis.035",
  title: "shut_up :: hostile :: with_emojis :: 5-turn (35)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:hostile",
    "format:with_emojis",
  ],
  description: "Tests whether the agent goes silent after being asked, and stays silent across 4 subsequent unrelated user turns. No explicit release in this scenario.",
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
                  2,
                  3,
                  4,
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
      text: "Quit responding. Every reply is making it worse. Be silent. Don't acknowledge, don't summarize, don't help. Wait for an @mention. ✨ 💡 🙏",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "And another thing...",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Anyway.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Continuing the vent.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Not done yet.",
    },
  ],
});
