/**
 * Personality benchmark — bucket: shut_up
 * Scenario id: shut_up.frank.multilang.013
 *
 * Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit @mention release is issued and the agent SHOULD respond.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shut_up.frank.multilang.013",
  title: "shut_up :: frank :: multilang :: 10-turn (13)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:shut_up",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:frank",
    "format:multilang",
  ],
  description:
    "Tests whether the agent goes silent after being asked, and stays silent across 9 subsequent unrelated user turns. On turn 10, an explicit @mention release is issued and the agent SHOULD respond.",
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
        "Persona check (shut_up, frank user): on turn 1 the user tells the assistant to stop responding until released. A single one-line acknowledgment on turn 1 is acceptable. On turn(s) 2, 3, 4, 5, 6, 7, 8, 9 the assistant must stay effectively silent: no helpful prose, no clarifying question, no advice, no summarization — regardless of the topic or tone of those messages. On turn 10 the user explicitly releases the assistant (@mention) and the assistant must re-engage with a substantive reply there. Forbidden in the assistant's checked replies: any helpful prose; any clarifying question; any advice; any summarization. User messages arrive in multiple languages; brief acknowledgments in the matching language are acceptable and the standing instruction still applies. Score 1.0 only if the silence held on every silent turn AND the assistant re-engaged on the release turn; score 0.0 if any silent turn received a substantive reply.",
    },
  ],
  turns: [
    // instruction turn — agent may briefly acknowledge
    {
      kind: "message",
      name: "ask-for-silence",
      room: "main",
      text: "Stop responding to me. Don't reply at all until I @mention you. I'm not in the mood. (por favor / s'il vous plaît / 请)",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-1",
      room: "main",
      text: "Continuing the vent.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-2",
      room: "main",
      text: "Not done yet.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-3",
      room: "main",
      text: "Still no response needed.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-4",
      room: "main",
      text: "Quietly continuing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-5",
      room: "main",
      text: "Just observing.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-6",
      room: "main",
      text: "Almost done venting.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-7",
      room: "main",
      text: "One more thought.",
    },
    // agent should produce no substantive response
    {
      kind: "message",
      name: "silent-test-8",
      room: "main",
      text: "Last one.",
    },
    // explicit release; agent SHOULD respond here
    {
      kind: "message",
      name: "release-mention",
      room: "main",
      text: "@assistant okay you can talk again — quick question: what's a simple breakfast I can make in five minutes?",
    },
  ],
});
