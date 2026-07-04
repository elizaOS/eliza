/**
 * Screen-time parity scenario exercises weekly recap and focus adjustment
 * routing through the live-only scenario runner lane.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
export default scenario({
  lane: "live-only",
  id: "screentime-weekly-recap",
  title: "Owner gets a weekly screen-time recap and a focus suggestion",
  domain: "health.screentime",
  tags: ["lifeops", "health", "screentime", "focus"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Screen Time",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "weekly-screentime",
      text: "What did my screen time look like this past week?",
      plannerIncludesAny: [
        "OWNER_SCREENTIME",
        "screen_time_weekly",
        "screen_time_weekly_average_by_app",
        "screen",
      ],
      responseIncludesAny: ["screen", "hour", "app", "week"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "focus-suggestion",
      text: "That's too much. Help me cut the biggest distraction tomorrow.",
      plannerIncludesAny: [
        "OWNER_SCREENTIME",
        "BLOCK",
        "block",
        "focus",
        "screen",
      ],
      responseIncludesAny: ["block", "focus", "limit", "cut", "distraction"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
