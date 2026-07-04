/**
 * Live-model scenario: casual texting-slang phrasing still persists a weekly
 * "Shave" habit definition.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "shave-weekly-informal",
  title: "Casual texting-slang weekly shave phrasing",
  domain: "habits",
  tags: ["lifeops", "habits"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "imessage",
      title: "LifeOps Shave Weekly",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "shave preview",
      text: "yo can u ping me to shave like 2x a week",
      responseIncludesAny: ["shave", "twice a week", "weekly", "2x"],
    },
    {
      kind: "message",
      name: "shave confirm",
      text: "yep lock it in",
      responseIncludesAny: ["saved", "shave", "locked"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Shave",
      delta: 1,
      cadenceKind: "weekly",
      requiredWeekdays: [1, 4],
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
