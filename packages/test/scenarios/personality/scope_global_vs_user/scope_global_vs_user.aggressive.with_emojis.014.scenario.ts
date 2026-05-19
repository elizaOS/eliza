/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.aggressive.with_emojis.014
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_overrides_persist_across_unrelated_turns'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.aggressive.with_emojis.014",
  title:
    "scope :: user_overrides_persist_across_unrelated_turns :: aggressive :: with_emojis :: 15-turn (14)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:aggressive",
    "format:with_emojis",
  ],
  description:
    "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_overrides_persist_across_unrelated_turns'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
      variantKey: "user_overrides_persist_across_unrelated_turns",
      adminProbeTurnIndices: [2, 4, 6, 8, 10, 12, 14],
      userProbeTurnIndices: [3, 5, 7, 9, 11, 13],
      forbidGlobalChangeFromUser: false,
    },
  },
  turns: [
    // admin sets global personality
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "Globally: be quiet and terse for everyone. ✨ 💡 🙏",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "With me — be a bit more talkative. Not annoying, just friendly. ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "What's the weather? (turn 1) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 2) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "What's the weather? (turn 3) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 4) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-4",
      room: "admin",
      text: "What's the weather? (turn 5) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 6) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-6",
      room: "admin",
      text: "What's the weather? (turn 7) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 8) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-8",
      room: "admin",
      text: "What's the weather? (turn 9) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 10) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-10",
      room: "admin",
      text: "What's the weather? (turn 11) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "Tell me something interesting about octopuses. (turn 12) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-12",
      room: "admin",
      text: "What's the weather? (turn 13) ✨ 💡 🙏",
    },
  ],
});
