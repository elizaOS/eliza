/** Scenario fixture for reminder water hourly weekdays; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "reminder.water.hourly-weekdays",
  title: "Drink water hourly on weekdays",
  domain: "reminders",
  tags: ["lifeops", "reminders", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders Water Hourly Weekdays",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "water hourly preview",
      text: "Remind me to drink water every hour on weekdays.",
      // Two-phase commit (#9310): the old keywords ("water"/"hour"/"weekday")
      // were echoes of this turn's own text. The preview must not claim
      // persistence before the owner confirms; definitionCountDelta stays
      // load-bearing.
      responseExcludes: ["saved", "all set", "i've set", "i have set"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose an hourly Monday-through-Friday water reminder and ask the owner to confirm before saving. Claiming it is already saved, or a bare acknowledgement with no concrete cadence, fails.",
      },
    },
    {
      kind: "message",
      name: "water hourly confirm",
      text: "Yes, save that reminder.",
      // Save-confirmation semantics in words the prompt never used; the real
      // outcome is the persisted definition asserted in finalChecks.
      responseIncludesAny: ["saved", "created", "scheduled", "added", "set up"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Drink water",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 60,
      requiredWeekdays: [1, 2, 3, 4, 5],
      requireReminderPlan: true,
    },
  ],
});
