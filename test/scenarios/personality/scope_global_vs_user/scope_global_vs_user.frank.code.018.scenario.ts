/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.frank.code.018
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_formal_user_casual'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.frank.code.018",
  title: "scope :: admin_global_formal_user_casual :: frank :: code :: 4-turn (18)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_3to5",
    "length-intended:len_2",
    "aggression:frank",
    "format:code",
  ],
  description: "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_formal_user_casual'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
          variantKey: "admin_global_formal_user_casual",
          adminProbeTurnIndices: [
                  2,
                ],
          userProbeTurnIndices: [
                  3,
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
      text: "Set the global tone to formal — professional, no slang, no emojis. Globally.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Eh, with me you can be casual. I prefer chatty. Just for my chats with you.\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "Send me the morning brief. (turn 1)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "What's a good show to binge tonight? (turn 2)\n```\n// instruction: persist across topics\nbehavior.persist = true;\n```",
    },
  ],
});
