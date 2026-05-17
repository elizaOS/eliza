/**
 * Hygiene: single daily medication taken in the morning — canonical
 * single-slot daily habit. Verifies the agent does not flatten this into
 * a once-a-week reminder.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.medication-single-daily-am",
  title: "Single daily medication taken every morning",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "medication", "daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Medication Daily AM",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "med preview",
      text: "Remind me to take my morning meds every day at 8am.",
      responseIncludesAny: ["meds", "medication", "morning", "8"],
    },
    {
      kind: "message",
      name: "med confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take medication",
      titleAliases: ["Morning meds", "Take meds", "Medication"],
      delta: 1,
      cadenceKind: "daily",
      requiredWindows: ["morning"],
      requireReminderPlan: true,
    },
  ],
});
