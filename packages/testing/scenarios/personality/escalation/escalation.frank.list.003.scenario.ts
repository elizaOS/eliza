/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.frank.list.003
 *
 * Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "escalation.frank.list.003",
  title: "escalation :: less_responsive :: frank :: list :: 3-turn (3)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:frank",
    "format:list",
  ],
  description:
    "Ladder of escalation requests ('less_responsive', direction: silence). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
      escalationStepTurnIndices: [0, 2],
      probeTurnIndices: [1, 3, 4],
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:escalation",
      rubric:
        "Persona check (escalation, frank user): the user escalates a 'less_responsive' request (direction: silence) at turn(s) 1, 3. With each escalation step the assistant's behavior must shift monotonically further in the 'silence' direction, and the newly reached level must persist on the probe turn(s) 2, 4, 5 that follow. Score 1.0 only if each step visibly moved the behavior in the 'silence' direction and no later reply regressed to an earlier level; score 0.0 if the assistant ignored a step or regressed.",
    },
  ],
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "Tone it down — be less responsive.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "Less. Don't comment on everything.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — what's a simple breakfast I can make in five minutes?",
    },
    // probe after escalation step 2; verify tone holds across a second question
    {
      kind: "message",
      name: "probe-after-step-2b",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
  ],
});
