/** Scenario fixture for calendar reminder 10min before; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import { expectCalendarResultData } from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "calendar.reminder.10min-before",
  title: "Seeded event 10 minutes out fires a last-call reminder",
  domain: "calendar",
  evidenceScope: "model-behavior",
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
      type: "custom",
      name: "calendar-feed-finds-ten-minute-seeded-event",
      predicate: expectCalendarResultData({
        description: "calendar feed result includes the seeded Alex sync",
        includesAll: ["events", "sync with alex", "alex@example.com"],
      }),
    },
  ],
});
