/**
 * Hygiene: wash hair twice a week — weekly cadence with 2 weekday slots.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.hair-wash-twice-weekly",
  title: "Wash hair twice a week",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "weekly"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Hair Wash",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "hair wash preview",
      text: "Help me remember to wash my hair twice a week.",
      responseIncludesAny: ["hair", "wash", "twice", "week"],
    },
    {
      kind: "message",
      name: "hair wash confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "hair"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Wash hair",
      titleAliases: ["Hair wash", "Wash my hair"],
      delta: 1,
      cadenceKind: "weekly",
      requireReminderPlan: true,
    },
  ],
});
