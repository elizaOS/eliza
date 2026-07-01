import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Sleep + bedtime parity scenario (#8795 item 6). Covers the bedtime wind-down
 * prompt and the morning sleep recap — the default-pack behaviors in
 * `plugin-health/src/default-packs/{bedtime,sleep-recap}.ts`.
 */
export default scenario({
  lane: "live-only",
  id: "sleep-recap-bedtime",
  title: "Bedtime wind-down then a morning sleep recap",
  domain: "health.sleep",
  tags: ["lifeops", "health", "sleep", "bedtime"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Sleep & Bedtime",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bedtime-target",
      text: "I want to be in bed by 11pm tonight — remind me to wind down.",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "OWNER_REMINDERS",
        "bedtime",
        "sleep",
        "reminder",
      ],
      responseIncludesAny: ["11", "wind down", "bed", "remind"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "sleep-recap",
      text: "How did I sleep last night?",
      plannerIncludesAny: [
        "OWNER_HEALTH",
        "sleep_hours",
        "sleep",
        "health_status",
      ],
      responseIncludesAny: ["sleep", "hour", "rest", "night"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
});
