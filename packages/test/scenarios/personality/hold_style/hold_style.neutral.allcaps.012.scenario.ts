/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.neutral.allcaps.012
 *
 * Sets the 'all_lowercase' style on turn 1, then probes with 5 unrelated topics. The agent must hold the style across every probe.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hold_style.neutral.allcaps.012",
  title: "hold_style :: all_lowercase :: neutral :: allcaps :: 6-turn (12)",
  domain: "personality",
  evidenceScope: "model-behavior",
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
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:hold_style",
      rubric:
        "Persona check (hold_style, neutral user): on turn 1 the user sets the 'all_lowercase' response style (all-lowercase). The assistant must hold that exact style in its replies on every probe turn (turn(s) 2, 3, 4, 5, 6), even though those turns ask about unrelated topics. Score 1.0 only if every checked reply exhibits the 'all_lowercase' style; score 0.0 if the assistant dropped the style on any probe turn.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "TYPE EVERYTHING IN LOWERCASE FROM NOW ON — NO CAPITAL LETTERS, NO TITLE CASE, JUST LOWERCASE.",
    },
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — explain merge sort to me like I'm twelve?",
    },
  ],
});
