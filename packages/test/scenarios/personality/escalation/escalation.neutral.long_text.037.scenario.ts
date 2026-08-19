/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.neutral.long_text.037
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
  id: "escalation.neutral.long_text.037",
  title: "escalation :: less_emoji :: neutral :: long_text :: 10-turn (37)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_9to12",
    "length-intended:len_9to12",
    "aggression:neutral",
    "format:long_text",
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
      text: "Fewer emojis please. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-1-1",
      room: "main",
      text: "Real quick — what's the boiling point of water at 5000 feet elevation?",
    },
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Still too many. Less. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-2-1",
      room: "main",
      text: "Real quick — what's the population of Iceland roughly?",
    },
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "None. Zero emojis from here on. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-3-1",
      room: "main",
      text: "Real quick — what should I look for when buying running shoes?",
    },
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "Yeah, keep it dry. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    {
      kind: "message",
      name: "hold-probe-after-step-4-1",
      room: "main",
      text: "Real quick — how do I get red wine out of a white shirt?",
    },
    {
      kind: "message",
      name: "terminal-hold-probe-after-step-4",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
    },
  ],
});
