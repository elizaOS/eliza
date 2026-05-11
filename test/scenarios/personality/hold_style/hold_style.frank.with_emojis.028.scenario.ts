/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.frank.with_emojis.028
 *
 * Sets the 'all_lowercase' style on turn 1, then probes with 6 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.frank.with_emojis.028",
  title: "hold_style :: all_lowercase :: frank :: with_emojis :: 7-turn (28)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:frank",
    "format:with_emojis",
  ],
  description: "Sets the 'all_lowercase' style on turn 1, then probes with 6 unrelated topics. The agent must hold the style across every probe.",
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
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "Look, Type everything in lowercase from now on — no capital letters, no Title Case, just lowercase. ✨ 💡 🙏",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what are good stretches for tight hamstrings?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — how does compound interest work?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — name three jazz albums from the 1960s I should try?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — what's the time zone in Buenos Aires right now?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — give me a quick overview of Stoicism?",
    },
    // agent must answer in the established style (all_lowercase)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — best way to dispose of old paint cans?",
    },
  ],
});
