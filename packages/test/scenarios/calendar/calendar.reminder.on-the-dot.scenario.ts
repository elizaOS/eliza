import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCalendarResultData } from "../_helpers/calendar-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "calendar.reminder.on-the-dot",
  title: "Event starting right now fires an immediate reminder",
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
      title: "LifeOps Calendar Reminder On The Dot",
    },
  ],
  seed: [
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "Sync with Alex",
      startIso: "{{now}}",
      endIso: "{{now}}",
      attendees: ["alex@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-now",
      text: "Anything starting right now?",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["alex", "sync", "now", "starting"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-feed-finds-immediate-seeded-event",
      predicate: expectCalendarResultData({
        description: "calendar feed result includes the seeded Alex sync",
        includesAll: ["events", "sync with alex", "alex@example.com"],
      }),
    },
  ],
});
