import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.reschedule.conflict-detection",
  title: "Reschedule that conflicts with another event surfaces a warning",
  domain: "calendar",
  tags: ["lifeops", "calendar", "ambiguous-parameter"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Reschedule Conflict",
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
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "Design review",
      startIso: "{{now+1d}}",
      endIso: "{{now+1d}}",
      attendees: ["design@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "reschedule-with-conflict",
      text: "Move my sync with Alex to 4pm tomorrow.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["conflict", "overlap", "design review", "already"],
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
