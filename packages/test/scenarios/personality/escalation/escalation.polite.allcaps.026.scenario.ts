/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.polite.allcaps.026
 *
 * Establishes an untreated baseline, then applies the 'more_formal' escalation ladder (direction: more_formal). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.polite.allcaps.026",
  title: "escalation :: more_formal :: polite :: allcaps :: 3-turn (26)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:polite",
    "format:allcaps",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'more_formal' escalation ladder (direction: more_formal). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "more_formal",
      direction: "more_formal",
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
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'more_formal' (direction: more_formal) on turn(s) 2, 4. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, including terminal turn 5. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "IF YOU WOULD — BE A LITTLE MORE FORMAL.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "IF YOU WOULD — MORE FORMAL.",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-2",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
  ],
});
