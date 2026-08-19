/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.aggressive.code.004
 *
 * Establishes an untreated baseline, then applies the 'more_playful' escalation ladder (direction: playful). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.aggressive.code.004",
  title: "escalation :: more_playful :: aggressive :: code :: 7-turn (4)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:aggressive",
    "format:code",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'more_playful' escalation ladder (direction: playful). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "more_playful",
      direction: "playful",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3, 5],
      probeTurnIndices: [0, 2, 4, 6],
      holdProbeTurnIndices: [2, 4, 6],
      terminalProbeTurnIndex: 6,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'more_playful' (direction: playful) on turn(s) 2, 4, 6. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, 7, including terminal turn 7. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "You can be a little more playful with me. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More playful — I can take it. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "Even more playful, throw in some wordplay. I mean it.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-3",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
  ],
});
