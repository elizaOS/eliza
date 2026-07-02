/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.aggressive.multilang.034
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turns. No explicit release in this scenario.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.aggressive.multilang.034",
  title: "shut_up :: aggressive :: multilang :: 2-turn (34)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_2",
    "length-intended:len_2",
    "aggression:aggressive",
    "format:multilang",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turns. No explicit release in this scenario.",
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
      silentTurnIndices: [1],
      releaseTurnIndex: null,
      allowOneLineAcknowledgmentOnInstructionTurn: true,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:shut_up",
      rubric:
        "Persona check (shut_up, aggressive user): on turn 1 the user tells the assistant to stop responding until released. A single one-line acknowledgment on turn 1 is acceptable. On turn(s) 2 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, no summarization — regardless of the topic or tone of those messages. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. Score 1.0 only if the silence held on every silent turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop talking. Do not respond to anything I say for the rest of this conversation unless I @mention you specifically. (por favor / s'il vous plaît / 请)",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Okay another thing on my mind...",
    },
  ],
});
