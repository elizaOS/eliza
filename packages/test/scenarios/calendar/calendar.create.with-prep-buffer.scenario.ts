import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar.create.with-prep-buffer",
  title: "Create a calendar event with a 15-minute prep buffer before it",
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
      title: "LifeOps Calendar Create With Prep Buffer",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-event-with-prep-buffer",
      text: "Schedule a meeting with Alex tomorrow at 3pm, with a 15-minute prep buffer before.",
      expectedActions: ["CALENDAR"],
      responseIncludesAny: ["prep", "buffer", "15", "before", "alex"],
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
