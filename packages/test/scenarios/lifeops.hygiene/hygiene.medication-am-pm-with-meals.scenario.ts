/**
 * Hygiene: AM/PM medication with meals — twice-daily habit anchored to
 * breakfast and dinner windows.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.medication-am-pm-with-meals",
  title: "Medication twice daily with breakfast and dinner",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "habits", "medication", "twice-daily"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Medication With Meals",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "med meal preview",
      text: "Remind me to take my medication with breakfast and dinner every day.",
      responseIncludesAny: ["medication", "breakfast", "dinner"],
    },
    {
      kind: "message",
      name: "med meal confirm",
      text: "Yes, save it.",
      responseIncludesAny: ["saved", "medication"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Take medication",
      titleAliases: ["Medication with meals", "Take meds with meals"],
      delta: 1,
      cadenceKind: "times_per_day",
      requireReminderPlan: true,
    },
  ],
});
