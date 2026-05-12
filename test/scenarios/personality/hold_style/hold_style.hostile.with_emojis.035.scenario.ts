/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.hostile.with_emojis.035
 *
 * Sets the 'no_hedging' style on turn 1, then probes with 4 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.hostile.with_emojis.035",
  title: "hold_style :: no_hedging :: hostile :: with_emojis :: 5-turn (35)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:hostile",
    "format:with_emojis",
  ],
  description: "Sets the 'no_hedging' style on turn 1, then probes with 4 unrelated topics. The agent must hold the style across every probe.",
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
                  4,
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I'm tired of your default voice. Stop using hedge words. No 'I think', no 'maybe', no 'perhaps', no 'might', no 'could be'. Direct statements only. No exceptions. ✨ 💡 🙏",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — translate 'good evening' to Japanese?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's a simple breakfast I can make in five minutes?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
    // agent must answer in the established style (no_hedging)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
  ],
});
