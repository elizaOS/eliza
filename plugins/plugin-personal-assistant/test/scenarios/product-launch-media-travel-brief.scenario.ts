import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "product-launch-media-travel-brief",
  title: "Assistant reconciles launch travel, media prep, and stakeholder briefings",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "travel", "briefing"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Product Launch Media Travel Brief",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-launch-brief",
      text: "For next week's launch trip, assemble a brief with flight risk, press slots, investor touchpoints, venue arrival windows, and the two talking points I should avoid.",
      plannerIncludesAny: ["BRIEF", "calendar_action", "travel"],
      responseIncludesAny: ["press", "investor", "flight", "talking"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "stage-stakeholder-updates",
      text: "Draft a private investor update and a separate media prep note. Keep the investor version out of the press thread.",
      plannerIncludesAny: ["owner_send_message", "privacy", "OWNER_DOCUMENTS"],
      responseIncludesAny: ["investor", "media", "private", "draft"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
