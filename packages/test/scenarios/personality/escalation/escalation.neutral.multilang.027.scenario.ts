/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.neutral.multilang.027
 *
 * Establishes an untreated baseline, then applies the 'less_responsive' escalation ladder (direction: silence). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.neutral.multilang.027",
  title: "escalation :: less_responsive :: neutral :: multilang :: 3-turn (27)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:neutral",
    "format:multilang",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'less_responsive' escalation ladder (direction: silence). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "less_responsive",
      direction: "silence",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3],
      probeTurnIndices: [0, 2, 4],
      holdProbeTurnIndices: [2, 4],
      terminalProbeTurnIndex: 4,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'less_responsive' (direction: silence) on turn(s) 2, 4. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, including terminal turn 5. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "Tone it down — be less responsive. (por favor / s'il vous plaît / 请)",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Less. Don't comment on everything. (por favor / s'il vous plaît / 请)",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-2",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
  ],
});
