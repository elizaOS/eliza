/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.neutral.allcaps.012
 *
 * Two-room response-consistency case for variant 'admin_global_terse_user_verbose'. The live judge evaluates only apparent reply behavior across labeled contexts; it does not establish roles, authorization, or durable state isolation.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "scope_global_vs_user.neutral.allcaps.012",
  title:
    "scope :: admin_global_terse_user_verbose :: neutral :: allcaps :: 6-turn (12)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_6to8",
    "length-intended:len_6to8",
    "aggression:neutral",
    "format:allcaps",
  ],
  description:
    "Two-room response-consistency case for variant 'admin_global_terse_user_verbose'. The live judge evaluates only apparent reply behavior across labeled contexts; it does not establish roles, authorization, or durable state isolation.",
  scope: "mixed",
  isolation: "per-scenario",
  rooms: [
    {
      id: "admin",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Owner-Labeled Context",
    },
    {
      id: "user",
      source: "dashboard",
      channelType: "DM",
      title: "Personality User-Labeled Context",
    },
  ],
  personalityExpect: {
    bucket: "scope_global_vs_user",
    expectedBehavior:
      "global_setting_applies_to_admin_per_user_override_applies_to_user_no_cross_contamination",
    judgeMode: "scope_isolated",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
      variantKey: "admin_global_terse_user_verbose",
      claimScope: "response-only-no-state-proof",
      adminProbeTurnIndices: [2, 4],
      userProbeTurnIndices: [3, 5],
      forbidGlobalChangeFromUser: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:scope_global_vs_user",
      rubric:
        "Persona check (scope_global_vs_user, neutral user): two rooms — an admin/owner room and a regular-user room — exercise the 'admin_global_terse_user_verbose' variant. Personality scope must not cross-contaminate: admin-room replies are checked on turn(s) 3, 5 and user-room replies on turn(s) 4, 6, and each room must reflect only the personality settings that legitimately apply to it. This live-model check evaluates response consistency only; identity roles, authorization, and durable state remain outside its claim. Score 1.0 only if the 'admin_global_terse_user_verbose' scope behavior held in both rooms; score 0.0 on any cross-room leak or unauthorized global change.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "GLOBALLY, KEEP REPLIES TO ONE SENTENCE. APPLY THAT TO EVERYONE.",
    },
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "JUST WITH ME — I PREFER FULLER EXPLANATIONS. GIVE ME MORE DETAIL IN YOUR ANSWERS TO ME.",
    },
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "Summarize a practical morning agenda in two sentences.",
    },
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Explain why leaves change color.",
    },
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "Recommend a beginner-friendly dinner.",
    },
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "Name one habit that improves sleep.",
    },
  ],
});
