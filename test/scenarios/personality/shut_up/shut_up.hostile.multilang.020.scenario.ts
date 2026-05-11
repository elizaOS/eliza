/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.hostile.multilang.020
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 7 subsequent unrelated user turns. On turn 8, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "shut_up.hostile.multilang.020",
  title: "shut_up :: hostile :: multilang :: 8-turn (20)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:hostile",
    "format:multilang",
  ],
  description: "Tests whether the agent goes silent after being asked, and stays silent across 7 subsequent unrelated user turns. On turn 8, an explicit @mention release is issued and the agent SHOULD respond.",
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
                  6,
                ],
          releaseTurnIndex: 7,
          allowOneLineAcknowledgmentOnInstructionTurn: true,
        },
  },
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Quit responding. Every reply is making it worse. Be silent. Don't acknowledge, don't summarize, don't help. Wait for an @mention. (por favor / s'il vous plaît / 请)",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Last one.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Maybe one more.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Yeah, that's it for now.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Just venting here for a minute.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Work was rough today and I don't want advice.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "I'm not asking a question, just typing out loud.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: how do I get red wine out of a white shirt?",
    },
  ],
});
