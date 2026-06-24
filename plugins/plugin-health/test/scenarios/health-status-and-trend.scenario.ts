import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Health domain parity scenario (#8795 item 6). Exercises the owner asking for
 * a current health snapshot and a weekly trend — routing to the OWNER_HEALTH
 * surface (plugin-health factories behind the personal-assistant wrapper).
 */
export default scenario({
  lane: "live-only",
  id: "health-status-and-trend",
  title: "Owner reads current health status and a weekly trend",
  domain: "health",
  tags: ["lifeops", "health", "owner"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Health Status",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "health-status",
      text: "How am I doing health-wise today — steps, heart rate, sleep?",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "health_status",
        "health_today",
        "health",
      ],
      responseIncludesAny: ["step", "heart", "sleep", "health"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "health-trend",
      text: "What's my trend for the last week?",
      plannerIncludesAny: ["OWNER_HEALTH", "health_trend", "trend"],
      responseIncludesAny: ["week", "trend", "up", "down", "average"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
});
