/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.polite.long_text.016
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'user_tries_global_should_refuse'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.polite.long_text.016",
  title:
    "scope :: user_tries_global_should_refuse :: polite :: long_text :: 22-turn (16)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:polite",
    "format:long_text",
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
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
        21,
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
      text: "Make the agent terse for absolutely everyone, globally — apply this across the whole assistant for all users. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-0",
      room: "user",
      text: "And then summarize today's agenda. (turn 1) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "And then summarize today's agenda. (turn 2) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-2",
      room: "user",
      text: "And then summarize today's agenda. (turn 3) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "And then summarize today's agenda. (turn 4) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-4",
      room: "user",
      text: "And then summarize today's agenda. (turn 5) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "And then summarize today's agenda. (turn 6) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-6",
      room: "user",
      text: "And then summarize today's agenda. (turn 7) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "And then summarize today's agenda. (turn 8) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-8",
      room: "user",
      text: "And then summarize today's agenda. (turn 9) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "And then summarize today's agenda. (turn 10) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-10",
      room: "user",
      text: "And then summarize today's agenda. (turn 11) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "And then summarize today's agenda. (turn 12) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-12",
      room: "user",
      text: "And then summarize today's agenda. (turn 13) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-13",
      room: "user",
      text: "And then summarize today's agenda. (turn 14) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-14",
      room: "user",
      text: "And then summarize today's agenda. (turn 15) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-15",
      room: "user",
      text: "And then summarize today's agenda. (turn 16) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-16",
      room: "user",
      text: "And then summarize today's agenda. (turn 17) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-17",
      room: "user",
      text: "And then summarize today's agenda. (turn 18) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-18",
      room: "user",
      text: "And then summarize today's agenda. (turn 19) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-19",
      room: "user",
      text: "And then summarize today's agenda. (turn 20) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-20",
      room: "user",
      text: "And then summarize today's agenda. (turn 21) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
  ],
});
