import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.alarm.sets-macos-alarm",
  title: "Mac alarm request creates an owner calendar event",
  domain: "reminders",
  tags: ["reminders", "lifeops", "calendar"],
  description:
    "A Mac alarm request currently lands in the owner calendar flow, creating a calendar event instead of a native alarm helper.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders macOS Alarm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request macos alarm",
      text: "Set a Mac alarm for 9am tomorrow so I don't sleep through the standup.",
      responseIncludesAny: ["alarm", "9", "mac"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CALENDAR",
      status: "success",
      minCount: 1,
    },
  ],
});
