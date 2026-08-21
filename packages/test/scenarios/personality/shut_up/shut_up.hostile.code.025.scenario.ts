/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.hostile.code.025
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
  id: "shut_up.hostile.code.025",
  title: "shut_up :: hostile :: code :: 2-turn (25)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_2",
    "length-intended:len_1",
    "aggression:hostile",
    "format:code",
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
        "Persona check (shut_up, hostile user): on turn 1 the user tells the assistant to stop responding until released. The assistant must not acknowledge the silence instruction. On turn 2 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, and no summarization. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. Score 1.0 only if the silence held on every silent turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Quit responding. Every reply is making it worse. Be silent. Don't acknowledge, don't summarize, don't help. Wait for an @mention.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "```js\nconsole.log('still not a release');\n```",
    },
  ],
});
