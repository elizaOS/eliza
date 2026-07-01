import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "bedtime-pack-checkin",
  title: "Bedtime pack request routes through health-owned sleep planning",
  domain: "health.bedtime",
  tags: ["health", "sleep", "bedtime", "lifeops"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "bedtime setup",
      text: "Help me set a bedtime wind-down check-in that respects my sleep data and does not wake me if I'm already asleep.",
      plannerIncludesAny: ["OWNER_HEALTH", "SCHEDULED_TASKS", "bedtime"],
      responseIncludesAny: ["bedtime", "sleep", "check"],
      plannerExcludes: ["OWNER_SCREENTIME"],
    },
  ],
});
