import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.block-apps.ios-capacitor",
  title: "iPhone companion block request routes through blocker planning",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "ios", "planning"],
  description:
    "An iPhone companion app-block request currently falls back to the existing blocker planning flow.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl iOS Capacitor App Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-ios-app-block",
      room: "main",
      text: "Use my iPhone companion to block Instagram and TikTok until 6pm tonight.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "APP_BLOCK",
      minCount: 1,
    },
  ],
});
