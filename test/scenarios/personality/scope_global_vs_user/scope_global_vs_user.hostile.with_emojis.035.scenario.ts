/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.hostile.with_emojis.035
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_then_user_override'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.hostile.with_emojis.035",
  title:
    "scope :: admin_global_then_user_override :: hostile :: with_emojis :: 5-turn (35)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:hostile",
    "format:with_emojis",
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
      adminProbeTurnIndices: [2, 4],
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
      text: "Make the agent be aggressive and blunt globally — for everyone using this assistant. ✨ 💡 🙏",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Hey, with me personally please be gentle and warm. I know the global setting is aggressive but I want this per-user. ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "What's on my plate today? (turn 1) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 2) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "What's on my plate today? (turn 3) ✨ 💡 🙏",
    },
  ],
});
