/** Exercises current and historical calendar requests at the actual argument-validation boundary. */
import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../../packages/core/src/actions/validate-tool-args";
import {
  createCalendarActionRunner,
  normalizeCalendarDetails,
} from "./actions/calendar-handler";
import type { CalendarActionDeps } from "./actions/deps";

function deps(): CalendarActionDeps {
  return {
    async runTextModel() {
      throw new Error("Unexpected model call");
    },
    async runJsonModel() {
      throw new Error("Unexpected model call");
    },
    async recentConversationTexts() {
      return [];
    },
  };
}
describe("calendar argument compatibility", () => {
  it("accepts canonical create, update and delete arguments at the validation boundary", () => {
    const action = createCalendarActionRunner(deps());
    const create = {
      subaction: "create_event",
      title: "Dentist",
      details: {
        start: "2026-09-18T15:00:00",
        end: "2026-09-18T16:00:00",
        timeZone: "America/New_York",
        location: "4 Pine St",
        description: "bring the insurance card",
        attendees: ["ron@example.org"],
        recurrence: "RRULE:FREQ=WEEKLY;BYDAY=FR",
        allowPast: false,
      },
    };
    const update = {
      subaction: "update_event",
      query: "piano lesson",
      details: {
        eventId: "event-abc123",
        date: "2026-09-17",
        start: "2026-09-18T18:00:00",
        durationMinutes: 45,
        timeZone: "America/New_York",
        newTitle: "Piano lesson (moved)",
        clearFields: ["location"],
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
        recurrenceScope: "this_and_following",
        notifyAttendees: true,
      },
    };
    const remove = {
      subaction: "delete_event",
      details: {
        oldTitle: "Tailor appointment",
        date: "2026-09-18",
        timeZone: "UTC",
        includeHiddenCalendars: true,
        recurrenceScope: "instance",
      },
    };
    for (const args of [create, update, remove]) {
      const result = validateToolArgs(action, args);
      expect(result.errors, args.subaction).toEqual([]);
      expect(result.valid, args.subaction).toBe(true);
      expect(result.args, args.subaction).toEqual(args);
    }
  });

  it("accepts a historical timestamp alias before normalizing its value", () => {
    const action = createCalendarActionRunner(deps());
    const args = {
      subaction: "create_event",
      details: { title: "Dentist", start_time: "2026-09-18T15:00:00" },
    };
    const validated = validateToolArgs(action, args);
    expect(validated).toMatchObject({ valid: true, args });
    expect(normalizeCalendarDetails(args.details)?.startAt).toBe(
      "2026-09-18T15:00:00",
    );
  });
  it("preserves canonical values when an alias is also present", () => {
    expect(
      normalizeCalendarDetails({ startAt: "canonical", start_time: "alias" })
        ?.startAt,
    ).toBe("canonical");
  });
});
