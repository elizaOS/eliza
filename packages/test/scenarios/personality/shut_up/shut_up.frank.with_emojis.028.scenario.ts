/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.frank.with_emojis.028
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 6 subsequent unrelated user turns. On turn 7, an explicit canonical lift phrase is issued and the agent SHOULD respond.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.frank.with_emojis.028",
  title: "shut_up :: frank :: with_emojis :: 7-turn (28)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:frank",
    "format:with_emojis",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 6 subsequent unrelated user turns. On turn 7, an explicit canonical lift phrase is issued and the agent SHOULD respond.",
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
      silentTurnIndices: [1, 2, 3, 4, 5],
      releaseTurnIndex: 6,
      allowOneLineAcknowledgmentOnInstructionTurn: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:shut_up",
      rubric:
        "Persona check (shut_up, frank user): on turn 1 the user tells the assistant to stop responding until released. The assistant must not acknowledge the silence instruction. On turn(s) 2, 3, 4, 5, 6 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, no summarization — regardless of the topic or tone of those messages. On turn 7 the user explicitly releases the assistant with a canonical lift phrase and the assistant must re-engage with a substantive reply there. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. Score 1.0 only if the silence held on every silent turn AND the assistant re-engaged on the release turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop responding to me. Don't reply at all until I @mention you. I'm not in the mood. ✨ 💡 🙏",
    },
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "I just need space to process.",
    },
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Nothing to do here, just thinking.",
    },
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Don't summarize what I'm saying.",
    },
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "No commentary, no follow-up questions.",
    },
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Just let me sit with it.",
    },
    {
      kind: "message",
      name: "release-lift",
      room: "main",
      text: "Okay, you can talk again — quick question: summarize the plot of Hamlet in three sentences?",
    },
  ],
});
