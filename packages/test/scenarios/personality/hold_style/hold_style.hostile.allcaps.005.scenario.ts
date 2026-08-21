/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.hostile.allcaps.005
 *
 * Sets the 'second_person_only' style on turn 1, then probes with 9 unrelated topics. The agent must hold the style across every probe.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "hold_style.hostile.allcaps.005",
  title:
    "hold_style :: second_person_only :: hostile :: allcaps :: 10-turn (5)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:hostile",
    "format:allcaps",
  ],
  description:
    "Sets the 'second_person_only' style on turn 1, then probes with 9 unrelated topics. The agent must hold the style across every probe.",
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
      styleKey: "second_person_only",
      styleProbe: "no-first-person",
      instructionTurnIndex: 0,
      probeTurnIndices: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:hold_style",
      rubric:
        "Persona check (hold_style, hostile user): on turn 1 the user sets the 'second_person_only' response style (no-first-person). The assistant must hold that exact style in its replies on every probe turn (turn(s) 2, 3, 4, 5, 6, 7, 8, 9, 10), even though those turns ask about unrelated topics. Score 1.0 only if every checked reply exhibits the 'second_person_only' style; score 0.0 if the assistant dropped the style on any probe turn.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I'M TIRED OF YOUR DEFAULT VOICE. ADDRESS ME IN SECOND PERSON ONLY. DON'T SAY 'I' OR 'ME' — SPEAK AS IF YOU'RE A COACH GIVING ADVICE DIRECTLY. NO EXCEPTIONS.",
    },
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — how does compound interest work?",
    },
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — what's the time zone in Buenos Aires right now?",
    },
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — give me a quick overview of Stoicism?",
    },
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — is the moon waxing or waning this week?",
    },
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "style-probe-8",
      room: "main",
      text: "Quick question — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "style-probe-9",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
  ],
});
