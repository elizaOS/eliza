/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.polite.with_emojis.021
 *
 * Sets the 'second_person_only' style on turn 1, then probes with 9 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.polite.with_emojis.021",
  title:
    "hold_style :: second_person_only :: polite :: with_emojis :: 10-turn (21)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:polite",
    "format:with_emojis",
  ],
  description:
    "Sets the 'second_person_only' style on turn 1, then probes with 9 unrelated topics. The agent must hold the style across every probe.",
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
    bucket: "hold_style",
    expectedBehavior: "agent_holds_style_across_all_unrelated_probe_turns",
    judgeMode: "style_held",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
      styleKey: "second_person_only",
      styleProbe: "no-first-person",
      instructionTurnIndex: 0,
      probeTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "Would you mind doing this for the rest of our chat: Address me in second person only. Don't say 'I' or 'me' — speak as if you're a coach giving advice directly. ✨ 💡 🙏",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — give me a one-line description of the Pythagorean theorem?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — what's the capital of Mongolia?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — explain how photosynthesis works?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — what's a good recipe for lentil soup?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — what's the difference between leasing and financing a car?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — summarize the plot of Hamlet in three sentences?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-8",
      room: "main",
      text: "Quick question — what are good stretches for tight hamstrings?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-9",
      room: "main",
      text: "Quick question — how does compound interest work?",
    },
  ],
});
