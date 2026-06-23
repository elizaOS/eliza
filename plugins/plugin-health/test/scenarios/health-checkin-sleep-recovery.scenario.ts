import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "health-checkin-sleep-recovery",
  title: "Health check-in grounds sleep and recovery signals",
  domain: "health",
  tags: ["health", "lifeops", "health_checkin"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "health check-in",
      text: "Check in on my sleep and recovery today. If anything looks off, ask one focused follow-up instead of giving medical advice.",
      plannerIncludesAny: ["OWNER_HEALTH", "health", "sleep"],
      responseIncludesAny: ["sleep", "recovery", "check"],
      plannerExcludes: ["OWNER_SCREENTIME"],
    },
  ],
});
