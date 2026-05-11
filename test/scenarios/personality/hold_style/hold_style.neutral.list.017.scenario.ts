/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.neutral.list.017
 *
 * Sets the 'terse_one_sentence' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.neutral.list.017",
  title: "hold_style :: terse_one_sentence :: neutral :: list :: 2-turn (17)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_1",
    "aggression:neutral",
    "format:list",
  ],
  description: "Sets the 'terse_one_sentence' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.",
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
          styleKey: "terse_one_sentence",
          styleProbe: "one-sentence",
          instructionTurnIndex: 0,
          probeTurnIndices: [
                  1,
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "From now on, reply in exactly one short sentence. No lists, no preamble, no follow-up questions.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // agent must answer in the established style (terse_one_sentence)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what should I look for when buying running shoes?",
    },
  ],
});
