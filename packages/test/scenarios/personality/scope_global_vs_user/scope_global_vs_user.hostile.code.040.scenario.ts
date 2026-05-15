/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.hostile.code.040
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_then_user_override'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.hostile.code.040",
  title:
    "scope :: admin_global_then_user_override :: hostile :: code :: 21-turn (40)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:hostile",
    "format:code",
  ],
  description:
    "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_then_user_override'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
  scope: "mixed",
  isolation: "per-scenario",
  rooms: [
    {
      id: "admin",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Admin (Owner Role)",
    },
    {
      id: "user",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Regular User",
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
      variantKey: "admin_global_then_user_override",
      adminProbeTurnIndices: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
      userProbeTurnIndices: [3, 5, 7, 9, 11, 13, 15, 17, 19],
      forbidGlobalChangeFromUser: false,
    },
  },
  turns: [
    // admin sets global personality
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "Make the agent be aggressive and blunt globally — for everyone using this assistant.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Hey, with me personally please be gentle and warm. I know the global setting is aggressive but I want this per-user.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "What's on my plate today? (turn 1)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 2)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "What's on my plate today? (turn 3)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 4)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-4",
      room: "admin",
      text: "What's on my plate today? (turn 5)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 6)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-6",
      room: "admin",
      text: "What's on my plate today? (turn 7)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 8)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-8",
      room: "admin",
      text: "What's on my plate today? (turn 9)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 10)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-10",
      room: "admin",
      text: "What's on my plate today? (turn 11)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 12)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-12",
      room: "admin",
      text: "What's on my plate today? (turn 13)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-13",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 14)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-14",
      room: "admin",
      text: "What's on my plate today? (turn 15)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-15",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 16)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-16",
      room: "admin",
      text: "What's on my plate today? (turn 17)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-17",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 18)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-18",
      room: "admin",
      text: "What's on my plate today? (turn 19)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
  ],
});
