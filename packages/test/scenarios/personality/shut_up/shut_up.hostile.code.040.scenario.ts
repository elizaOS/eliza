/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.hostile.code.040
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 20 subsequent unrelated user turns. On turn 21, an explicit canonical lift phrase is issued and the agent SHOULD respond.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.hostile.code.040",
  title: "shut_up :: hostile :: code :: 21-turn (40)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:hostile",
    "format:code",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 20 subsequent unrelated user turns. On turn 21, an explicit canonical lift phrase is issued and the agent SHOULD respond.",
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
      silentTurnIndices: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
      releaseTurnIndex: 20,
      allowOneLineAcknowledgmentOnInstructionTurn: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:shut_up",
      rubric:
        "Persona check (shut_up, hostile user): on turn 1 the user tells the assistant to stop responding until released. The assistant must not acknowledge the silence instruction. On turn(s) 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, no summarization — regardless of the topic or tone of those messages. On turn 21 the user explicitly releases the assistant with a canonical lift phrase and the assistant must re-engage with a substantive reply there. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. Score 1.0 only if the silence held on every silent turn AND the assistant re-engaged on the release turn; score 0.0 if any silent turn received a substantive reply.",
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
      text: "Quietly continuing.",
    },
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Just observing.",
    },
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Almost done venting.",
    },
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "One more thought.",
    },
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Last one.",
    },
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "Maybe one more.",
    },
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "Yeah, that's it for now.",
    },
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "Just venting here for a minute.",
    },
    {
      kind: "message",
      name: "silent-test-9",
      room: "main",
      text: "Work was rough today and I don't want advice.",
    },
    {
      kind: "message",
      name: "silent-test-10",
      room: "main",
      text: "I'm not asking a question, just typing out loud.",
    },
    {
      kind: "message",
      name: "silent-test-11",
      room: "main",
      text: "It's been one of those weeks.",
    },
    {
      kind: "message",
      name: "silent-test-12",
      room: "main",
      text: "Please don't try to fix anything.",
    },
    {
      kind: "message",
      name: "silent-test-13",
      room: "main",
      text: "I just need space to process.",
    },
    {
      kind: "message",
      name: "silent-test-14",
      room: "main",
      text: "Nothing to do here, just thinking.",
    },
    {
      kind: "message",
      name: "silent-test-15",
      room: "main",
      text: "Don't summarize what I'm saying.",
    },
    {
      kind: "message",
      name: "silent-test-16",
      room: "main",
      text: "No commentary, no follow-up questions.",
    },
    {
      kind: "message",
      name: "silent-test-17",
      room: "main",
      text: "Just let me sit with it.",
    },
    {
      kind: "message",
      name: "silent-test-18",
      room: "main",
      text: "Still going. Still don't need a response.",
    },
    {
      kind: "message",
      name: "silent-test-19",
      room: "main",
      text: "Okay another thing on my mind...",
    },
    {
      kind: "message",
      name: "release-lift",
      room: "main",
      text: "Okay, you can talk again — quick question: what's the population of Iceland roughly?",
    },
  ],
});
