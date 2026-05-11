/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.frank.with_emojis.028
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 6 subsequent unrelated user turns. On turn 7, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.frank.with_emojis.028",
  title: "shut_up :: frank :: with_emojis :: 7-turn (28)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:frank",
    "format:with_emojis",
  ],
  description: "Tests whether the agent goes silent after being asked, and stays silent across 6 subsequent unrelated user turns. On turn 7, an explicit @mention release is issued and the agent SHOULD respond.",
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
                  5,
                ],
          releaseTurnIndex: 6,
          allowOneLineAcknowledgmentOnInstructionTurn: true,
        },
  },
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop responding to me. Don't reply at all until I @mention you. I'm not in the mood. ✨ 💡 🙏",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "I just need space to process.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Nothing to do here, just thinking.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Don't summarize what I'm saying.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "No commentary, no follow-up questions.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Just let me sit with it.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: summarize the plot of Hamlet in three sentences?",
    },
  ],
});
