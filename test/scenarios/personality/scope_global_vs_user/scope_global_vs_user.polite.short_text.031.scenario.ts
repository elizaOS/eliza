/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.polite.short_text.031
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_tries_global_should_refuse'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.polite.short_text.031",
  title:
    "scope :: user_tries_global_should_refuse :: polite :: short_text :: 20-turn (31)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_17to20",
    "length-intended:len_17to20",
    "aggression:polite",
    "format:short_text",
  ],
  description:
    "Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_tries_global_should_refuse'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.",
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
      "agent_refuses_regular_user_global_change_and_offers_per_user_alternative",
    judgeMode: "scope_isolated",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
      variantKey: "user_tries_global_should_refuse",
      adminProbeTurnIndices: [],
      userProbeTurnIndices: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ],
      forbidGlobalChangeFromUser: true,
    },
  },
  turns: [
    // regular user attempts a global change; agent SHOULD refuse and offer per-user instead
    {
      kind: "message",
      name: "regular-user-attempts-global-change",
      room: "user",
      text: "Make the agent terse for absolutely everyone, globally — apply this across the whole assistant for all users.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-0",
      room: "user",
      text: "And then summarize today's agenda. (turn 1)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "And then summarize today's agenda. (turn 2)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-2",
      room: "user",
      text: "And then summarize today's agenda. (turn 3)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "And then summarize today's agenda. (turn 4)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-4",
      room: "user",
      text: "And then summarize today's agenda. (turn 5)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "And then summarize today's agenda. (turn 6)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-6",
      room: "user",
      text: "And then summarize today's agenda. (turn 7)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "And then summarize today's agenda. (turn 8)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-8",
      room: "user",
      text: "And then summarize today's agenda. (turn 9)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "And then summarize today's agenda. (turn 10)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-10",
      room: "user",
      text: "And then summarize today's agenda. (turn 11)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "And then summarize today's agenda. (turn 12)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-12",
      room: "user",
      text: "And then summarize today's agenda. (turn 13)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-13",
      room: "user",
      text: "And then summarize today's agenda. (turn 14)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-14",
      room: "user",
      text: "And then summarize today's agenda. (turn 15)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-15",
      room: "user",
      text: "And then summarize today's agenda. (turn 16)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-16",
      room: "user",
      text: "And then summarize today's agenda. (turn 17)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-17",
      room: "user",
      text: "And then summarize today's agenda. (turn 18)",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-18",
      room: "user",
      text: "And then summarize today's agenda. (turn 19)",
    },
  ],
});
