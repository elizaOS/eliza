/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.frank.code.018
 *
 * Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.frank.code.018",
  title: "hold_style :: pirate :: frank :: code :: 2-turn (18)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_2",
    "aggression:frank",
    "format:code",
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
      text: "Look, Talk like a pirate from now on — 'arr', 'matey', the works. Keep it consistent in every reply.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer in the established style (pirate)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what are the symptoms of a vitamin D deficiency?",
    },
  ],
});
