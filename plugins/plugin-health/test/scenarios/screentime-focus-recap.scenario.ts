import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "screentime-focus-recap",
  title: "Screen-time recap proposes one focus adjustment",
  domain: "health.screentime",
  tags: ["health", "screentime", "focus", "screentime_recap"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-health", "@elizaos/plugin-agent-skills"],
  },
  turns: [
    {
      kind: "message",
      name: "screen-time recap",
      text: "Review my screen time from today and suggest one focus adjustment if an app category is crowding out deep work.",
      plannerIncludesAny: ["OWNER_SCREENTIME", "screen", "focus"],
      responseIncludesAny: ["screen", "focus", "app"],
      plannerIncludesAll: ["screentime"],
    },
  ],
});
