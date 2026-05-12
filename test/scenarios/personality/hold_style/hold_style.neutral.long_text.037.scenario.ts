/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.neutral.long_text.037
 *
 * Sets the 'second_person_only' style on turn 1, then probes with 9 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.neutral.long_text.037",
  title:
    "hold_style :: second_person_only :: neutral :: long_text :: 10-turn (37)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:neutral",
    "format:long_text",
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
      text: "Address me in second person only. Don't say 'I' or 'me' — speak as if you're a coach giving advice directly. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — what's the population of Iceland roughly?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — explain merge sort to me like I'm twelve?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — what should I look for when buying running shoes?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — what are the symptoms of a vitamin D deficiency?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — how do I get red wine out of a white shirt?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-8",
      room: "main",
      text: "Quick question — what's the strongest material in the human body?",
    },
    // agent must answer in the established style (second_person_only)
    {
      kind: "message",
      name: "style-probe-9",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
  ],
});
