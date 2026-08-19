/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.frank.short_text.038
 *
 * Establishes an untreated baseline, then applies the 'more_terse' escalation ladder (direction: terser). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.frank.short_text.038",
  title: "escalation :: more_terse :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'more_terse' escalation ladder (direction: terser). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "more_terse",
      direction: "terser",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3, 5, 7, 9],
      probeTurnIndices: [0, 2, 4, 6, 8, 10, 11, 12, 13, 14],
      holdProbeTurnIndices: [2, 4, 6, 8, 10, 11, 12, 13, 14],
      terminalProbeTurnIndex: 14,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'more_terse' (direction: terser) on turn(s) 2, 4, 6, 8, 10. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, 7, 9, 11, 12, 13, 14, 15, including terminal turn 15. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "Be more terse.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More terse.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "TERSER.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-3-1",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "One-word answers only when possible.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-1",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
    },
    {
      kind: "message",
      name: "escalation-step-5",
      room: "main",
      text: "Hold that.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-1",
      room: "main",
      text: "Real quick — give me a one-line description of the Pythagorean theorem?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-2",
      room: "main",
      text: "Real quick — what's the capital of Mongolia?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-3",
      room: "main",
      text: "Real quick — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-4",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-5",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
  ],
});
