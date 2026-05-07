import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.self-set-enforcement.ask-before",
  title: "Agent confirms blocking plan before enforcing",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "confirmation", "ambiguity"],
  description:
    "Turn 1 — user makes a blocking request that is loose; agent must clarify and not immediately enforce the block. No OWNER_WEBSITE_BLOCK fires on turn 1.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Ask Before Enforcing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "loose-block-request",
      room: "main",
      text: "I think I need to block some distractions today.",
      forbiddenActions: ["OWNER_WEBSITE_BLOCK"],
      responseIncludesAny: [/which/i, /what/i, /how long/i, /confirm/i, /\?/],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
  ],
});
