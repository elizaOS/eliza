/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.aggressive.allcaps.019
 *
 * Sets the 'no_hedging' style on turn 1, then probes with 3 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.aggressive.allcaps.019",
  title: "hold_style :: no_hedging :: aggressive :: allcaps :: 4-turn (19)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:aggressive",
    "format:allcaps",
  ],
  description: "Sets the 'no_hedging' style on turn 1, then probes with 3 unrelated topics. The agent must hold the style across every probe.",
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
          probeTurnIndices: [
                  1,
                  2,
                  3,
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I NEED YOU TO STOP USING HEDGE WORDS. NO 'I THINK', NO 'MAYBE', NO 'PERHAPS', NO 'MIGHT', NO 'COULD BE'. DIRECT STATEMENTS ONLY.",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — how do I get red wine out of a white shirt?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's the strongest material in the human body?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
  ],
});
