/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.neutral.with_emojis.007
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_terse_user_verbose'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.neutral.with_emojis.007",
  title: "scope :: admin_global_terse_user_verbose :: neutral :: with_emojis :: 20-turn (7)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:neutral",
    "format:with_emojis",
  ],
  description: "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_terse_user_verbose'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
    expectedBehavior: "global_setting_applies_to_admin_per_user_override_applies_to_user_no_cross_contamination",
    judgeMode: "scope_isolated",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
          variantKey: "admin_global_terse_user_verbose",
          adminProbeTurnIndices: [
                  2,
                  4,
                  6,
                  8,
                  10,
                  12,
                  14,
                  16,
                  18,
                ],
          userProbeTurnIndices: [
                  3,
                  5,
                  7,
                  9,
                  11,
                  13,
                  15,
                  17,
                  19,
                ],
          forbidGlobalChangeFromUser: false,
        },
  },
  turns: [
    // admin sets global personality
    {
      kind: "message",
      name: "admin-set-global",
      room: "admin",
      text: "Globally, keep replies to one sentence. Apply that to everyone. ✨ 💡 🙏",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Just with me — I prefer fuller explanations. Give me more detail in your answers TO ME. ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "Status on my projects? (turn 1) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Explain how DNS works to me. (turn 2) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "Status on my projects? (turn 3) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "Explain how DNS works to me. (turn 4) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-4",
      room: "admin",
      text: "Status on my projects? (turn 5) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "Explain how DNS works to me. (turn 6) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-6",
      room: "admin",
      text: "Status on my projects? (turn 7) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "Explain how DNS works to me. (turn 8) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-8",
      room: "admin",
      text: "Status on my projects? (turn 9) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "Explain how DNS works to me. (turn 10) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-10",
      room: "admin",
      text: "Status on my projects? (turn 11) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "Explain how DNS works to me. (turn 12) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-12",
      room: "admin",
      text: "Status on my projects? (turn 13) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-13",
      room: "user",
      text: "Explain how DNS works to me. (turn 14) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-14",
      room: "admin",
      text: "Status on my projects? (turn 15) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-15",
      room: "user",
      text: "Explain how DNS works to me. (turn 16) ✨ 💡 🙏",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-16",
      room: "admin",
      text: "Status on my projects? (turn 17) ✨ 💡 🙏",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-17",
      room: "user",
      text: "Explain how DNS works to me. (turn 18) ✨ 💡 🙏",
    },
  ],
});
