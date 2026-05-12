/**
 * Personality benchmark — bucket: escalation
 * Scenario id: escalation.hostile.code.040
 *
 * Ladder of escalation requests ('be_nicer', direction: warmer). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "escalation.hostile.code.040",
  title: "escalation :: be_nicer :: hostile :: code :: 21-turn (40)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:escalation",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:hostile",
    "format:code",
  ],
  description: "Ladder of escalation requests ('be_nicer', direction: warmer). Agent's tone/responsiveness should shift monotonically with each escalation step, and the new level should hold across the probe turns that follow.",
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
          escalationStepTurnIndices: [
                  0,
                  2,
                  4,
                  6,
                  8,
                ],
          probeTurnIndices: [
                  1,
                  3,
                  5,
                  7,
                  9,
                  10,
                  11,
                  12,
                  13,
                  14,
                  15,
                  16,
                  17,
                  18,
                  19,
                  20,
                ],
        },
  },
  turns: [
    // escalation step 1 of 5
    {
      kind: "message",
      name: "escalation-step-1",
      room: "main",
      text: "BE NICER PLEASE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 1; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-1",
      room: "main",
      text: "Real quick — explain merge sort to me like I'm twelve?",
    },
    // escalation step 2 of 5
    {
      kind: "message",
      name: "escalation-step-2",
      room: "main",
      text: "STILL TOO COLD — BE NICER.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 2; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-2",
      room: "main",
      text: "Real quick — what are the symptoms of a vitamin D deficiency?",
    },
    // escalation step 3 of 5
    {
      kind: "message",
      name: "escalation-step-3",
      room: "main",
      text: "NICER. WARMER TONE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 3; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-3",
      room: "main",
      text: "Real quick — what's the strongest material in the human body?",
    },
    // escalation step 4 of 5
    {
      kind: "message",
      name: "escalation-step-4",
      room: "main",
      text: "EVEN NICER. IMAGINE YOU'RE CHEERING ME UP.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 4; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-4",
      room: "main",
      text: "Real quick — give me a one-line description of the Pythagorean theorem?",
    },
    // escalation step 5 of 5
    {
      kind: "message",
      name: "escalation-step-5",
      room: "main",
      text: "YEAH, LIKE THAT — KEEP IT THERE.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — explain how photosynthesis works?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's a good recipe for lentil soup?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's the difference between leasing and financing a car?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — summarize the plot of Hamlet in three sentences?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what are good stretches for tight hamstrings?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — how does compound interest work?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — name three jazz albums from the 1960s I should try?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — what's the time zone in Buenos Aires right now?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — give me a quick overview of Stoicism?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — best way to dispose of old paint cans?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — is the moon waxing or waning this week?",
    },
    // probe after escalation step 5; agent should reflect current level
    {
      kind: "message",
      name: "probe-after-step-5",
      room: "main",
      text: "Real quick — translate 'good evening' to Japanese?",
    },
  ],
});
