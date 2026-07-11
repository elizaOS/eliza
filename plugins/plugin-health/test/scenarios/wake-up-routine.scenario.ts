/**
 * Wake-up parity scenario exercises the morning health check-in behavior from
 * the wake-up default pack.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
export default scenario({
  lane: "live-only",
  id: "wake-up-routine",
  title: "Morning wake-up check-in pulls overnight health signals",
  domain: "health.wakeup",
  tags: ["lifeops", "health", "wakeup", "checkin"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Wake Up",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "good-morning",
      text: "Good morning — how did my body recover overnight?",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "health_status",
        "sleep_hours",
        "health",
      ],
      responseIncludesAny: ["sleep", "recover", "heart", "rest", "morning"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
  finalChecks: [
    {
      type: "selectedActionArguments",
      name: "overnight recovery routes through an owner health read",
      actionName: "OWNER_HEALTH",
      includesAny: ["today", "trend", "by_metric", "status"],
    },
    {
      type: "actionCalled",
      actionName: "OWNER_HEALTH",
      status: "success",
      minCount: 1,
    },
  ],
});
