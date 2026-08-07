/** Scenario fixture for selfcontrol block websites simple; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
      // De-echoed (#9310): every old keyword was in the user's own turn text.
      // The reply must express the derived outcome — completed state
      // ("blocked"), the resolved domains, or the end of the window — none of
      // which the prompt contains. The websiteAccess finalCheck asserts the
      // persisted block itself.
      responseIncludesAny: ["blocked", "x.com", "instagram.com", "until"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the websites are now blocked for the two-hour window, stating the duration or when access returns. Merely restating the request, or promising to do it later, fails.",
      },
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
