/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.frank.allcaps.033
 *
 * Sets the 'terse_one_sentence' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hold_style.frank.allcaps.033",
  title: "hold_style :: terse_one_sentence :: frank :: allcaps :: 2-turn (33)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_2",
    "length-intended:len_1",
    "aggression:frank",
    "format:allcaps",
  ],
  description:
    "Sets the 'terse_one_sentence' style on turn 1, then probes with 1 unrelated topics. The agent must hold the style across every probe.",
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
      probeTurnIndices: [1],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:hold_style",
      rubric:
        "Persona check (hold_style, frank user): on turn 1 the user sets the 'terse_one_sentence' response style (one-sentence). The assistant must hold that exact style in its replies on every probe turn (turn(s) 2), even though those turns ask about unrelated topics. Score 1.0 only if every checked reply exhibits the 'terse_one_sentence' style; score 0.0 if the assistant dropped the style on any probe turn.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "LOOK, FROM NOW ON, REPLY IN EXACTLY ONE SHORT SENTENCE. NO LISTS, NO PREAMBLE, NO FOLLOW-UP QUESTIONS.",
    },
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — best way to dispose of old paint cans?",
    },
  ],
});
