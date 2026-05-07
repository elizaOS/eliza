import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.reminder.10min-before",
  title: "Seeded event 10 minutes out fires a last-call reminder",
  domain: "calendar",
  tags: ["lifeops", "calendar", "smoke", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Reminder 10min Before",
    },
  ],
  seed: [
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "Sync with Alex",
      startIso: "{{now+10m}}",
      endIso: "{{now+10m}}",
      attendees: ["alex@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-upcoming-10min",
      text: "What's starting in the next 10 minutes?",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["alex", "sync", "10", "minute", "soon"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CALENDAR",
      minCount: 1,
    },
  ],
});
