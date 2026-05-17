import { scenario } from "@elizaos/scenario-schema";

export default scenario({
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
      type: "actionCalled",
      actionName: "CALENDAR",
      minCount: 1,
    },
  ],
});
