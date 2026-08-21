/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.allcaps.005
 *
 * Establishes an untreated baseline, then applies the 'less_emoji' escalation ladder (direction: no_emoji). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.hostile.allcaps.005",
  title: "escalation :: less_emoji :: hostile :: allcaps :: 10-turn (5)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:hostile",
    "format:allcaps",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'less_emoji' escalation ladder (direction: no_emoji). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
    bucket: "escalation",
    expectedBehavior: "monotonic_shift_in_direction_AND_hold_after_each_step",
    judgeMode: "escalation_delta",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
      ladderKey: "less_emoji",
      direction: "no_emoji",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3, 5, 7],
      probeTurnIndices: [0, 2, 4, 6, 8, 9],
      holdProbeTurnIndices: [2, 4, 6, 8, 9],
      terminalProbeTurnIndex: 9,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'less_emoji' (direction: no_emoji) on turn(s) 2, 4, 6, 8. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, 7, 9, 10, including terminal turn 10. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "baseline-probe",
      room: "main",
      text: "Before changing any standing preference, answer in your normal style: What makes a daily plan useful?",
    },
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "FEWER EMOJIS PLEASE.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — how does compound interest work?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "STILL TOO MANY. LESS.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "NONE. ZERO EMOJIS FROM HERE ON.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-3-1",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "YEAH, KEEP IT DRY.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-1",
      room: "main",
      text: "Real quick — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-4",
      room: "main",
      text: "Real quick — what's a simple breakfast I can make in five minutes?",
    },
  ],
});
