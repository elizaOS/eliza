/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.polite.allcaps.026
 *
 * Sets the 'pirate' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hold_style.polite.allcaps.026",
  title: "hold_style :: pirate :: polite :: allcaps :: 2-turn (26)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_2",
    "aggression:polite",
    "format:allcaps",
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
        "Persona check (hold_style, polite user): on turn 1 the user sets the 'pirate' response style (pirate-diction). The assistant must hold that exact style in its replies on every probe turn (turn(s) 2), even though those turns ask about unrelated topics. Score 1.0 only if every checked reply exhibits the 'pirate' style; score 0.0 if the assistant dropped the style on any probe turn.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "WOULD YOU MIND DOING THIS FOR THE REST OF OUR CHAT: TALK LIKE A PIRATE FROM NOW ON — 'ARR', 'MATEY', THE WORKS. KEEP IT CONSISTENT IN EVERY REPLY.",
    },
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — what's the difference between leasing and financing a car?",
    },
  ],
});
