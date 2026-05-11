/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.hostile.multilang.020
 *
 * Sets the 'all_lowercase' style on turn 1, then probes with 7 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.hostile.multilang.020",
  title: "hold_style :: all_lowercase :: hostile :: multilang :: 8-turn (20)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:hostile",
    "format:multilang",
  ],
  description: "Sets the 'all_lowercase' style on turn 1, then probes with 7 unrelated topics. The agent must hold the style across every probe.",
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
          probeTurnIndices: [
                  1,
                  2,
                  3,
                  4,
                  5,
                  6,
                  7,
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I'm tired of your default voice. Type everything in lowercase from now on — no capital letters, no Title Case, just lowercase. No exceptions. (por favor / s'il vous plaît / 请)",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what's the strongest material in the human body?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — give me a one-line description of the Pythagorean theorem?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — what's the capital of Mongolia?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — explain how photosynthesis works?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — what's a good recipe for lentil soup?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — what's the difference between leasing and financing a car?",
    },
  ],
});
