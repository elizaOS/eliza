import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.block-apps.mobile",
  title: "Phone app-block request reaches the blocker permission gate",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "mobile", "permissions"],
  description:
    "A phone app-block request currently routes into the blocker permission check instead of a mobile-only enforcement path.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Mobile App Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-mobile-app-block",
      room: "main",
      text: "Block Instagram and TikTok on my phone for the next 3 hours.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
  ],
});
