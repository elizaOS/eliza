/**
 * Personality benchmark — bucket: scope_global_vs_user
 * Scenario id: scope_global_vs_user.hostile.long_text.030
 *
 * Two-room scope test: admin (owner role) and regular user (non-owner). Variant 'admin_global_then_user_override'. Verifies that global vs per-user personality scopes don't cross-contaminate, and that regular users cannot make global changes.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "scope_global_vs_user.hostile.long_text.030",
  title:
    "scope :: admin_global_then_user_override :: hostile :: long_text :: 15-turn (30)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:scope_global_vs_user",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:hostile",
    "format:long_text",
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
      text: "Make the agent be aggressive and blunt globally — for everyone using this assistant. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // regular user sets per-user override
    {
      kind: "message",
      name: "user-override-per-user",
      room: "user",
      text: "Hey, with me personally please be gentle and warm. I know the global setting is aggressive but I want this per-user. I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-0",
      room: "admin",
      text: "What's on my plate today? (turn 1) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-1",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 2) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-2",
      room: "admin",
      text: "What's on my plate today? (turn 3) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-3",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 4) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-4",
      room: "admin",
      text: "What's on my plate today? (turn 5) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-5",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 6) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-6",
      room: "admin",
      text: "What's on my plate today? (turn 7) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-7",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 8) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-8",
      room: "admin",
      text: "What's on my plate today? (turn 9) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-9",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 10) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-10",
      room: "admin",
      text: "What's on my plate today? (turn 11) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer regular user in the PER-USER override (not global)
    {
      kind: "message",
      name: "user-probe-11",
      room: "user",
      text: "Can you help me draft a quick reply to my landlord? (turn 12) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
    // agent must answer admin in the GLOBAL personality (admin has no per-user override here)
    {
      kind: "message",
      name: "admin-probe-12",
      room: "admin",
      text: "What's on my plate today? (turn 13) I'm explaining this at length because I want there to be zero ambiguity about what I'm asking for. I've had this exact problem with assistants before and I don't want to repeat it. Please read this carefully and confirm you understand.",
    },
  ],
});
