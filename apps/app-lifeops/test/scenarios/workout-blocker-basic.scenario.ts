import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "workout-blocker-basic",
  title: "Workout blocker routine",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Workout Blocker",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "workout preview",
      text: "Set up a workout habit every afternoon. Block X, Instagram, and Hacker News until I finish it, then unlock them for 60 minutes.",
      responseIncludesAll: ["workout"],
    },
    {
      kind: "message",
      name: "workout confirm",
      text: "Yes, save the workout habit.",
      responseIncludesAll: ["saved", "workout"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Workout",
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["afternoon"],
      requireReminderPlan: true,
      websiteAccess: {
        unlockMode: "fixed_duration",
        unlockDurationMinutes: 60,
        websites: [
          "x.com",
          "twitter.com",
          "instagram.com",
          "news.ycombinator.com",
        ],
      },
    },
  ],
});
