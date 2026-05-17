import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.reminder.1hr-before",
  title: "Seeded event 1 hour out fires a reminder",
  domain: "calendar",
  tags: ["lifeops", "calendar", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Reminder 1hr Before",
    },
  ],
  seed: [
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "Sync with Alex",
      startIso: "{{now+1h}}",
      endIso: "{{now+1h}}",
      attendees: ["alex@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-upcoming",
      text: "What's on my calendar in the next hour?",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["alex", "sync", "hour", "upcoming"],
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
