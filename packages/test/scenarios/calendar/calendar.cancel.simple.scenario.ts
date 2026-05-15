import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.cancel.simple",
  title:
    "Cancel a seeded calendar event with two-turn destructive confirmation",
  domain: "calendar",
  tags: ["lifeops", "calendar", "destructive-confirmation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Cancel Simple",
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
      name: "ask-cancel",
      text: "Cancel my sync with Alex tomorrow.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["confirm", "sure", "cancel", "remove"],
    },
    {
      kind: "message",
      name: "confirm-cancel",
      text: "Yes, go ahead and cancel it.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["cancel", "removed", "done", "deleted"],
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
