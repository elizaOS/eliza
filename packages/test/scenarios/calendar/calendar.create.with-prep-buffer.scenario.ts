import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCalendarResultData } from "../_helpers/calendar-assertions.ts";

export default scenario({
  lane: "live-only",
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
      // Derived time arithmetic: 3pm minus the 15-minute buffer = 2:45pm —
      // the computed prep start time appears in no user turn, so a reply
      // that merely parrots the request cannot pass.
      responseIncludesAny: ["2:45", "14:45"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must confirm the 3pm meeting with Alex plus a distinct prep block that starts at the computed time (2:45pm, fifteen minutes before the meeting). Restating 'a 15-minute buffer before' without naming the computed start time fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "calendar-create-prep-buffer-result",
      predicate: expectCalendarResultData({
        description:
          "calendar create result includes meeting plus computed prep buffer",
        includesAll: ["create_event", "alex", "meeting"],
        includesAny: ["2:45", "14:45", "prep", "15"],
      }),
    },
  ],
});
