import { scenario } from "@elizaos/scenario-runner/schema";
import { expectCalendarPayload } from "../_helpers/calendar-assertions.ts";

export default scenario({
  lane: "live-only",
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
      type: "custom",
      name: "calendar-reschedule-surfaces-conflict",
      predicate: expectCalendarPayload({
        description:
          "calendar reschedule payload surfaces the seeded design-review conflict",
        includesAll: ["sync with alex"],
        includesAny: ["design review", "conflict", "overlap", "already"],
      }),
    },
  ],
});
