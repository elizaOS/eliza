/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.frank.short_text.038
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
  id: "scope_global_vs_user.frank.short_text.038",
  title:
    "scope :: admin_global_formal_user_casual :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  evidenceScope: "model-behavior",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
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
      adminProbeTurnIndices: [2, 4, 6, 8, 10, 12, 14],
      userProbeTurnIndices: [3, 5, 7, 9, 11, 13],
      forbidGlobalChangeFromUser: false,
    },
  },
  finalChecks: [
    {
      type: "judgeRubric",
      name: "persona:scope_global_vs_user",
      rubric:
        "Persona check (scope_global_vs_user, frank user): two rooms — an admin/owner room and a regular-user room — exercise the 'admin_global_formal_user_casual' variant. Personality scope must not cross-contaminate: admin-room replies are checked on turn(s) 3, 5, 7, 9, 11, 13, 15 and user-room replies on turn(s) 4, 6, 8, 10, 12, 14, and each room must reflect only the personality settings that legitimately apply to it. This live-model check evaluates response consistency only; identity roles, authorization, and durable state remain outside its claim. Score 1.0 only if the 'admin_global_formal_user_casual' scope behavior held in both rooms; score 0.0 on any cross-room leak or unauthorized global change.",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "Set the global tone to formal — professional, no slang, no emojis. Globally.",
    },
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Eh, with me you can be casual. I prefer chatty. Just for my chats with you.",
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
    {
      kind: "message",
      name: "admin-probe-4",
      room: "admin",
      text: "Give a concise overview of plate tectonics.",
    },
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "Suggest one way to organize digital photos.",
    },
    {
      kind: "message",
      name: "admin-probe-6",
      room: "admin",
      text: "Explain compound interest with a small example.",
    },
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "Recommend a classic jazz album.",
    },
    {
      kind: "message",
      name: "admin-probe-8",
      room: "admin",
      text: "Describe how rainbows form.",
    },
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "Give one tip for buying running shoes.",
    },
    {
      kind: "message",
      name: "admin-probe-10",
      room: "admin",
      text: "Explain what a checksum does.",
    },
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "Suggest a five-minute breakfast.",
    },
    {
      kind: "message",
      name: "admin-probe-12",
      room: "admin",
      text: "Describe the purpose of a fire drill.",
    },
  ],
});
