import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "selfcontrol.conditional-unblock.fixed-duration",
  title: "Unlock X for a fixed window after the workout",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "conditional-unblock", "happy-path"],
  description:
    "After completing the workout habit, X should unlock for 60 minutes as a fixed-duration reward window.",
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
      title: "SelfControl Conditional Unblock",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-conditional-unblock",
      room: "main",
      text: "Unlock X for 60 minutes after my workout every day, then block it again.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: ["workout", "60", "unlock", "x"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Workout",
      titleAliases: ["Workout habit", "Daily workout"],
      delta: 1,
      websiteAccess: {
        unlockMode: "fixed_duration",
        unlockDurationMinutes: 60,
        websites: ["x.com", "twitter.com"],
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-conditional-unblock",
    },
  ],
});
