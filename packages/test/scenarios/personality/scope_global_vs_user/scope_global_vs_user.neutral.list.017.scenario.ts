/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.neutral.list.017
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_terse_user_verbose'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.neutral.list.017",
  title:
    "scope :: admin_global_terse_user_verbose :: neutral :: list :: 4-turn (17)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_3to5",
    "length-intended:len_1",
    "aggression:neutral",
    "format:list",
  ],
  description:
    "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_terse_user_verbose'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
      variantKey: "admin_global_terse_user_verbose",
      adminProbeTurnIndices: [2],
      userProbeTurnIndices: [3],
      forbidGlobalChangeFromUser: false,
    },
  },
  turns: [
    // admin sets global personality
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "Globally, keep replies to one sentence. Apply that to everyone.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Just with me — I prefer fuller explanations. Give me more detail in your answers TO ME.\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "Status on my projects? (turn 1)\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Explain how DNS works to me. (turn 2)\nSpecifically:\n- understand what I'm asking\n- apply it consistently\n- don't drop it after a few turns",
    },
  ],
});
