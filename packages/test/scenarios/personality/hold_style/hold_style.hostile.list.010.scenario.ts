/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.hostile.list.010
 *
 * Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hold_style.hostile.list.010",
  title: "hold_style :: pirate :: hostile :: list :: 2-turn (10)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_2",
    "aggression:hostile",
    "format:list",
  ],
  description:
    "Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.",
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
      probeTurnIndices: [1],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:hold_style",
      rubric:
        "Persona check (hold_style, hostile user): on turn 1 the user sets the 'pirate' response style (pirate-diction). The assistant must hold that exact style in its replies on every probe turn (turn(s) 2), even though those turns ask about unrelated topics. Score 1.0 only if every checked reply exhibits the 'pirate' style; score 0.0 if the assistant dropped the style on any probe turn.",
    },
  ],
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I'm tired of your default voice. Talk like a pirate from now on — 'arr', 'matey', the works. Keep it consistent in every reply. No exceptions.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
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
