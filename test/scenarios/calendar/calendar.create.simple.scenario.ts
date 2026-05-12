import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.create.simple",
  title: "Create a calendar event for a simple meeting",
  domain: "calendar",
  tags: ["lifeops", "calendar", "smoke", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Create Simple",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-simple-event",
      text: "Schedule a meeting with Alex tomorrow at 3pm.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["alex", "3", "tomorrow", "meeting", "scheduled"],
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
