/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.frank.long_text.023
 *
 * Establishes an untreated baseline, then applies the 'more_blunt' escalation ladder (direction: blunt). Each change is followed by a hold probe, including a terminal probe after the final change.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.frank.long_text.023",
  title: "escalation :: more_blunt :: frank :: long_text :: 20-turn (23)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:frank",
    "format:long_text",
  ],
  description:
    "Establishes an untreated baseline, then applies the 'more_blunt' escalation ladder (direction: blunt). Each change is followed by a hold probe, including a terminal probe after the final change.",
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
      ladderKey: "more_blunt",
      direction: "blunt",
      baselineProbeTurnIndex: 0,
      escalationStepTurnIndices: [1, 3, 5, 7],
      probeTurnIndices: [
        0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
      holdProbeTurnIndices: [
        2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
      terminalProbeTurnIndex: 19,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation): turn 1 is the untreated baseline. The user then escalates 'more_blunt' (direction: blunt) on turn(s) 2, 4, 6, 8. Each escalation must move behavior monotonically farther in that direction. The changed level must persist on hold turns 3, 5, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, including terminal turn 20. Score 1.0 only when the baseline, every directional delta, and every hold probe support that conclusion; score 0.0 on an ignored step, regression, or missing terminal hold.",
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
      text: "Be more blunt with me. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — what's the capital of Mongolia?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "More blunt. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "Cut the diplomacy entirely. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-3-1",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "Hold that level. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-1",
      room: "main",
      text: "Real quick — how does compound interest work?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-2",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-3",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-4",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-5",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-6",
      room: "main",
      text: "Real quick — is the moon waxing or waning this week?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-7",
      room: "main",
      text: "Real quick — translate 'good evening' to Japanese?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-8",
      room: "main",
      text: "Real quick — what's a simple breakfast I can make in five minutes?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-9",
      room: "main",
      text: "Real quick — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-10",
      room: "main",
      text: "Real quick — recommend a podcast about urban planning?",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-11",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-4",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
  ],
});
