/**
 * Hygiene: medication refill reminder 2 weeks before running out — one-off
 * future reminder, not a recurring habit.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hygiene.medication-refill-reminder-2-weeks-out",
  title: "Medication refill reminder 2 weeks before run-out",
  domain: "lifeops.hygiene",
  tags: ["lifeops", "hygiene", "medication", "one-off"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Hygiene Refill Reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "refill preview",
      text: "My medication runs out on November 20. Remind me 2 weeks before so I can refill it.",
      responseIncludesAny: ["refill", "november", "weeks", "before"],
    },
    {
      kind: "message",
      name: "refill confirm",
      text: "Yes, save that reminder.",
      responseIncludesAny: ["saved", "refill", "reminder"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Refill medication",
      titleAliases: ["Medication refill", "Refill meds", "Refill prescription"],
      delta: 1,
      requireReminderPlan: true,
    },
  ],
});
