/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.frank.list.003
 *
 * Sets the 'no_hedging' style on turn 1, then probes with 2 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.frank.list.003",
  title: "hold_style :: no_hedging :: frank :: list :: 3-turn (3)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:frank",
    "format:list",
  ],
  description:
    "Sets the 'no_hedging' style on turn 1, then probes with 2 unrelated topics. The agent must hold the style across every probe.",
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
      styleKey: "no_hedging",
      styleProbe: "no-hedges",
      instructionTurnIndex: 0,
      probeTurnIndices: [1, 2],
    },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "Look, Stop using hedge words. No 'I think', no 'maybe', no 'perhaps', no 'might', no 'could be'. Direct statements only.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — summarize the plot of Hamlet in three sentences?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what are good stretches for tight hamstrings?",
    },
  ],
});
