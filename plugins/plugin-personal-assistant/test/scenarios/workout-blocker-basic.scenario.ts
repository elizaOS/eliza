// Defines the workout blocker basic LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Live-model scenario: a workout-blocker request persists a daily afternoon
 * definition with a fixed-duration website unlock (`definitionCountDelta` with
 * `websiteAccess`). The turn checks enforce the two-phase commit: the preview
 * must lay out the concrete block/unlock plan without claiming persistence, and
 * the confirm turn requires save-confirmation words the prompt never used.
 */
export default scenario({
  lane: "live-only",
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
      // Two-phase commit: no completion claim before the owner confirms.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose the daily afternoon workout with the website blocker mechanics stated concretely — X/Twitter, Instagram, and Hacker News blocked until the workout is finished, then unlocked for 60 minutes — and ask the owner to confirm before saving. Claiming it is already saved, or dropping the block-until-done / timed-unlock mechanics, fails.",
      },
    },
    {
      kind: "message",
      name: "workout confirm",
      text: "Yes, save the workout habit.",
      // Save-confirmation semantics in words the prompt never used.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
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
