/**
 * Live-model scenario: a stretch-break request persists a "Stretch" task with
 * the default daytime break cadence.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "stretch-breaks",
  title: "Stretch default breaks during the day",
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
      title: "LifeOps Stretch Breaks",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stretch default preview",
      text: "help me remember to stretch during the day",
      responseIncludesAny: ["stretch", "during the day", "reminder"],
    },
    {
      kind: "message",
      name: "stretch default confirm",
      text: "yes, save that routine",
      responseIncludesAny: ["saved", "stretch"],
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Stretch",
      delta: 1,
      cadenceKind: "interval",
      requiredEveryMinutes: 360,
      requiredMaxOccurrencesPerDay: 2,
      requiredWindows: ["afternoon", "evening"],
      requireReminderPlan: true,
    },
  ],
});
