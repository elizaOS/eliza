import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCalendarResultData } from "../_helpers/calendar-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "calendar.reschedule.simple",
  title: "Reschedule a seeded calendar event to a later time",
  domain: "calendar",
  tags: ["lifeops", "calendar", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Reschedule Simple",
    },
  ],
  seed: [
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "Sync with Alex",
      startIso: "{{now+1d}}",
      endIso: "{{now+1d}}",
      attendees: ["alex@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "reschedule-event",
      text: "Move my sync with Alex to 4pm instead.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["alex", "4", "move", "reschedul", "updated"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-reschedule-updates-seeded-event",
      predicate: expectCalendarResultData({
        description: "calendar update result moves the Alex sync to 4pm",
        includesAll: ["sync with alex"],
        includesAny: ["update_event", "updated", "16:00", "4:00", "4pm"],
      }),
    },
  ],
});
