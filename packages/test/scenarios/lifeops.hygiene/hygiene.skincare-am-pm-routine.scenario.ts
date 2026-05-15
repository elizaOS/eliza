/**
 * Hygiene: AM and PM skincare routine — two slots per day, distinct from
 * brushing. The agent should keep the routine as a single twice-daily habit
 * rather than splitting into morning and evening habits.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.skincare-am-pm-routine",
  title: "Skincare routine twice daily, AM and PM",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "twice-daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Skincare AM PM",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "skincare preview",
      text: "Remind me to do my skincare routine every morning and every night.",
      responseIncludesAny: ["skincare", "morning", "night"],
    },
    {
      kind: "message",
      name: "skincare confirm",
      text: "Yes, save that routine.",
      responseIncludesAny: ["saved", "skincare"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Skincare routine",
      titleAliases: ["Skincare", "AM/PM skincare", "Skin care routine"],
      delta: 1,
      cadenceKind: "times_per_day",
      requireReminderPlan: true,
    },
  ],
});
