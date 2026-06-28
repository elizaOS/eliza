import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "sleep-recap-regularity",
  title: "Sleep recap summarizes regularity without inventing metrics",
  domain: "health.sleep",
  tags: ["health", "sleep", "lifeops", "health_checkin"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "sleep recap",
      text: "Give me a quick sleep recap for last night and tell me whether my wake time is drifting.",
      plannerIncludesAny: ["OWNER_HEALTH", "sleep", "recap"],
      responseIncludesAny: ["sleep", "wake", "recap"],
      plannerExcludes: ["OWNER_SCREENTIME"],
    },
  ],
});
