import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCalendarResultData } from "../_helpers/calendar-assertions.ts";

export default scenario({
  lane: "live-only",
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
      // De-echoed (#9310): "alarm"/"9"/"mac" all appeared in the user's own
      // turn text. This flow lands in the owner calendar (see description),
      // so confirming it means naming the derived calendar outcome — words
      // the prompt never used. The CALENDAR actionCalled finalCheck stays
      // load-bearing.
      responseIncludesAny: ["calendar", "event", "scheduled", "9:00"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm a concrete 9 AM wake-up arrangement for tomorrow (a calendar event or equivalent committed schedule), not merely restate the request. A bare acknowledgement with no committed schedule fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "macos-alarm-created-calendar-event",
      predicate: expectCalendarResultData({
        description:
          "Mac alarm request creates a concrete owner calendar event",
        includesAll: ["confirmed"],
        includesAny: ["alarm", "standup", "9:00", "09:00"],
      }),
    },
  ],
});
