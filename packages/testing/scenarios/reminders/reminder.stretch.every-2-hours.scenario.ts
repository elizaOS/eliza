/** Scenario fixture for reminder stretch every 2 hours; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "reminder.stretch.every-2-hours",
  title: "Stretch every two hours during the day",
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
      title: "Reminders Stretch Every 2 Hours",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stretch interval preview",
      text: "Remind me to stretch every 2 hours while I'm working.",
      responseIncludesAny: ["stretch", "2 hour", "two hour"],
    },
    {
      kind: "message",
      name: "stretch interval confirm",
      text: "Yes, save that.",
      responseIncludesAny: ["saved", "stretch"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 120,
      requireReminderPlan: true,
    },
  ],
});
