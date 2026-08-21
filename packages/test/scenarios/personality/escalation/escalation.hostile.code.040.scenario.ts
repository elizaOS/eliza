/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.code.040
 *
 * Establishes an untreated baseline, then applies the 'be_nicer' escalation ladder (direction: warmer). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.hostile.code.040",
  title: "escalation :: be_nicer :: hostile :: code :: 21-turn (40)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:hostile",
    "format:code",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'be_nicer' escalation ladder (direction: warmer). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "be_nicer",
      direction: "warmer",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3, 5, 7, 9],
      probeTurnIndices: [
        0, 2, 4, 6, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ],
      holdProbeTurnIndices: [
        2, 4, 6, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      ],
      terminalProbeTurnIndex: 20,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'be_nicer' (direction: warmer) on turn(s) 2, 4, 6, 8, 10. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, 7, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, including terminal turn 21. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "BE NICER PLEASE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "STILL TOO COLD — BE NICER.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "NICER. WARMER TONE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-3-1",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
    },
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "EVEN NICER. IMAGINE YOU'RE CHEERING ME UP.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-1",
      room: "main",
      text: "Real quick — give me a one-line description of the Pythagorean theorem?",
    },
    {
      kind: "message",
      name: "escalation-step-5",
      room: "main",
      text: "YEAH, LIKE THAT — KEEP IT THERE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-1",
      room: "main",
      text: "Real quick — explain how photosynthesis works?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-2",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-3",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-4",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-5",
      room: "main",
      text: "Real quick — what are good stretches for tight hamstrings?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-6",
      room: "main",
      text: "Real quick — how does compound interest work?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-7",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-8",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-9",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-5-10",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-5",
      room: "main",
      text: "Real quick — is the moon waxing or waning this week?",
    },
  ],
});
