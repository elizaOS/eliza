/** Scenario fixture for selfcontrol conditional unblock fixed duration; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
      // De-echoed (#9310): every old keyword was in the user's own turn text.
      // The reply must describe the derived reward-window mechanics — a
      // one-hour window that re-locks afterwards — in words the prompt never
      // used. The websiteAccess finalCheck asserts the persisted rule itself.
      responseIncludesAny: ["window", "hour", "reward", "re-block", "relock"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the conditional-unlock rule: finishing the daily workout opens a fixed 60-minute access window for X, after which the block resumes automatically. Missing the automatic re-block half of the rule fails.",
      },
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
