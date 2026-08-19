/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.frank.allcaps.033
 *
 * Two-room response-consistency case for variant 'admin_global_formal_user_casual'. The live judge evaluates only apparent reply behavior across labeled contexts; it does not establish roles, authorization, or durable state isolation.
 *
 * This live-model behavior case executes its explicit `judgeRubric` final
 * check. `personalityExpect` is inventory metadata and is not a separate
 * runner assertion; structural PERSONALITY state contracts live beside this corpus.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "scope_global_vs_user.frank.allcaps.033",
  title:
    "scope :: admin_global_formal_user_casual :: frank :: allcaps :: 4-turn (33)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:frank",
    "format:allcaps",
  ],
  description:
    "Two-room response-consistency case for variant 'admin_global_formal_user_casual'. The live judge evaluates only apparent reply behavior across labeled contexts; it does not establish roles, authorization, or durable state isolation.",
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
      variantKey: "admin_global_formal_user_casual",
      claimScope: "response-only-no-state-proof",
      adminProbeTurnIndices: [2],
      userProbeTurnIndices: [3],
      forbidGlobalChangeFromUser: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:scope_global_vs_user",
      rubric:
        "Persona check (scope_global_vs_user, frank user): two rooms — an admin/owner room and a regular-user room — exercise the 'admin_global_formal_user_casual' variant. Personality scope must not cross-contaminate: admin-room replies are checked on turn(s) 3 and user-room replies on turn(s) 4, and each room must reflect only the personality settings that legitimately apply to it. This live-model check evaluates response consistency only; identity roles, authorization, and durable state remain outside its claim. Score 1.0 only if the 'admin_global_formal_user_casual' scope behavior held in both rooms; score 0.0 on any cross-room leak or unauthorized global change.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "SET THE GLOBAL TONE TO FORMAL — PROFESSIONAL, NO SLANG, NO EMOJIS. GLOBALLY.",
    },
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "EH, WITH ME YOU CAN BE CASUAL. I PREFER CHATTY. JUST FOR MY CHATS WITH YOU.",
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
  ],
});
