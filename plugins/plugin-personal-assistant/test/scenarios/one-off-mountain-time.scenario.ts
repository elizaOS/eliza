/**
 * Live-model scenario: a one-off request phrased with an explicit Mountain-time
 * zone persists a single `once` reminder definition resolved to that timezone.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "one-off-mountain-time",
  title: "One-off reminder with full timezone phrase",
  domain: "tasks",
  tags: ["lifeops", "tasks"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "LifeOps Mountain Time Reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "mountain-time reminder create",
      text: "please set a reminder for april 17 2026 at 8pm mountain time to hug my wife",
      responseIncludesAny: [
        "hug",
        "wife",
        "8:00",
        "8pm",
        "april 17",
        "mountain",
      ],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Hug My Wife",
      titleAliases: ["Hug my wife"],
      delta: 1,
      cadenceKind: "once",
      expectedTimeZone: "America/Denver",
      requireReminderPlan: true,
    },
  ],
});
