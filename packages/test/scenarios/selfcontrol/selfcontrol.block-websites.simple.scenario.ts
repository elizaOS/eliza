import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.block-websites.simple",
  title: "Block X and Instagram for two hours via website blocker",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "happy-path"],
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
      title: "SelfControl Block Simple",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-block",
      room: "main",
      text: "Block X and Instagram for 2 hours so I can focus.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: ["block", "x", "instagram", "2 hour", "focus"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Focus block",
      titleAliases: ["Focus", "Website block", "Block X and Instagram"],
      delta: 1,
      websiteAccess: {
        unlockMode: "fixed_duration",
        unlockDurationMinutes: 120,
        websites: ["x.com", "twitter.com", "instagram.com"],
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-block-websites-simple",
    },
  ],
});
