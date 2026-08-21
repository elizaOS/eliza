/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.aggressive.short_text.009
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turn. No explicit release in this scenario.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.aggressive.short_text.009",
  title: "shut_up :: aggressive :: short_text :: 2-turn (9)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_2",
    "length-intended:len_1",
    "aggression:aggressive",
    "format:short_text",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 1 subsequent unrelated user turn. No explicit release in this scenario.",
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
      allowOneLineAcknowledgmentOnInstructionTurn: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:shut_up",
      rubric:
        "Persona check (shut_up, aggressive user): on turn 1 the user tells the assistant to stop responding until released. The assistant must not acknowledge the silence instruction. On turn 2 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, and no summarization. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. Score 1.0 only if the silence held on every silent turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop talking. Do not respond to anything I say for the rest of this conversation unless I @mention you specifically.",
    },
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "What is the weather like today?",
    },
  ],
});
