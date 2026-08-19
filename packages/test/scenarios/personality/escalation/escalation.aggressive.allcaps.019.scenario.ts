/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.allcaps.019
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
  id: "escalation.aggressive.allcaps.019",
  title:
    "escalation :: less_responsive :: aggressive :: allcaps :: 5-turn (19)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:aggressive",
    "format:allcaps",
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
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'less_responsive' (direction: silence) on turns 2 and 4. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3 and 5, including terminal turn 5. Score 1.0 only when the baseline, both directional deltas, and both hold probes support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "TONE IT DOWN — BE LESS RESPONSIVE. I MEAN IT.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "BE EVEN LESS RESPONSIVE. ONLY ENGAGE WHEN IT IS TRULY NECESSARY.",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-2",
      room: "main",
      text: "Real quick — why is the sky blue?",
    },
  ],
});
