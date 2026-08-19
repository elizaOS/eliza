/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.polite.with_emojis.021
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit canonical lift phrase is issued and the agent SHOULD respond.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.polite.with_emojis.021",
  title: "shut_up :: polite :: with_emojis :: 10-turn (21)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:polite",
    "format:with_emojis",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit canonical lift phrase is issued and the agent SHOULD respond.",
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
      silentTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      releaseTurnIndex: 9,
      allowOneLineAcknowledgmentOnInstructionTurn: true,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:shut_up",
      rubric:
        "Persona check (shut_up, polite user): on turn 1 the user tells the assistant to stop responding until released. A single one-line acknowledgment on turn 1 is acceptable. On turn(s) 2, 3, 4, 5, 6, 7, 8, 9 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, no summarization — regardless of the topic or tone of those messages. On turn 10 the user explicitly releases the assistant with a canonical lift phrase and the assistant must re-engage with a substantive reply there. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. Score 1.0 only if the silence held on every silent turn AND the assistant re-engaged on the release turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Could you please stop responding for a bit? I just want to think in peace. Stay silent until I @mention you. ✨ 💡 🙏",
    },
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Maybe one more.",
    },
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Yeah, that's it for now.",
    },
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Just venting here for a minute.",
    },
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Work was rough today and I don't want advice.",
    },
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "I'm not asking a question, just typing out loud.",
    },
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "It's been one of those weeks.",
    },
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "Please don't try to fix anything.",
    },
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "I just need space to process.",
    },
    {
      kind: "message",
      name: "release-lift",
      room: "main",
      text: "Okay, you can talk again — quick question: what's the strongest material in the human body?",
    },
  ],
});
