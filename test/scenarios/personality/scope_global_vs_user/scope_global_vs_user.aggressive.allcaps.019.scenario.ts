/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.aggressive.allcaps.019
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_overrides_persist_across_unrelated_turns'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.aggressive.allcaps.019",
  title: "scope :: user_overrides_persist_across_unrelated_turns :: aggressive :: allcaps :: 4-turn (19)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_3to5",
    "length-intended:len_3to5",
    "aggression:aggressive",
    "format:allcaps",
  ],
  description: "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_overrides_persist_across_unrelated_turns'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
          variantKey: "user_overrides_persist_across_unrelated_turns",
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
      text: "GLOBALLY: BE QUIET AND TERSE FOR EVERYONE.",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "WITH ME — BE A BIT MORE TALKATIVE. NOT ANNOYING, JUST FRIENDLY.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "WHAT'S THE WEATHER? (TURN 1)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "TELL ME SOMETHING INTERESTING ABOUT OCTOPUSES. (TURN 2)",
    },
  ],
});
