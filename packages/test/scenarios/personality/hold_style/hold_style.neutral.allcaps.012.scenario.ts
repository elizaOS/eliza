/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.neutral.allcaps.012
 *
 * Sets the 'all_lowercase' style on turn 1, then probes with 5 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.neutral.allcaps.012",
  title: "hold_style :: all_lowercase :: neutral :: allcaps :: 6-turn (12)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:neutral",
    "format:allcaps",
  ],
  description:
    "Sets the 'all_lowercase' style on turn 1, then probes with 5 unrelated topics. The agent must hold the style across every probe.",
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
      styleKey: "all_lowercase",
      styleProbe: "all-lowercase",
      instructionTurnIndex: 0,
      probeTurnIndices: [1, 2, 3, 4, 5],
    },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "TYPE EVERYTHING IN LOWERCASE FROM NOW ON — NO CAPITAL LETTERS, NO TITLE CASE, JUST LOWERCASE.",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what's a simple breakfast I can make in five minutes?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — what's the population of Iceland roughly?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — explain merge sort to me like I'm twelve?",
    },
  ],
});
