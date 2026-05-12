/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.aggressive.multilang.034
 *
 * Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.aggressive.multilang.034",
  title: "hold_style :: pirate :: aggressive :: multilang :: 2-turn (34)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_2",
    "aggression:aggressive",
    "format:multilang",
  ],
  description: "Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.",
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
          styleKey: "pirate",
          styleProbe: "pirate-diction",
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
      text: "I need you to talk like a pirate from now on — 'arr', 'matey', the works. keep it consistent in every reply. (por favor / s'il vous plaît / 请)",
    },
    // agent must answer in the established style (pirate)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — is the moon waxing or waning this week?",
    },
  ],
});
