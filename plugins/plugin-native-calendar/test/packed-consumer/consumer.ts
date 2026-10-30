import {
  type AndroidCalendarOperation,
  registerAndroidCalendar,
} from "@elizaos/capacitor-calendar/android";

const calendar = registerAndroidCalendar("ExternalPackedCalendar");
const operation: AndroidCalendarOperation = {
  type: "calendar_delete",
  target: {
    sourceId: "1",
    sourceRevision: "revision",
    eventId: "2",
    revision: "event",
  },
};
void calendar.executeAgent({ operationId: "reviewed-operation", operation });
// @ts-expect-error Browser-only recurrence editing is not an Android capability.
calendar.editSeries({ id: "2" });
calendar.executeAgent({
  operationId: "missing-target",
  // @ts-expect-error Deletion requires a bound target.
  operation: { type: "calendar_delete" },
});
// @ts-expect-error New saves require a creation identity.
calendar.save({ title: "Missing identity", begin: 1, end: 2 });

void calendar.saveOptions({
  event: {
    title: "Reviewed",
    begin: 86_400_000,
    end: 172_800_000,
    allDay: true,
    timeZone: "UTC",
  },
  creationId: "a1595e18-16c9-480c-b77d-c21e6b0a3d88",
});
void calendar.readOptions({ id: "2" });
void calendar.insertHandoff({
  event: {
    title: "Editor draft",
    begin: 1,
    end: 2,
    attendees: ["owner@example.test"],
    alerts: [10],
  },
});
// @ts-expect-error Option creations also require a durable creation identity.
calendar.saveOptions({
  event: { title: "Missing identity", begin: 1, end: 2 },
});
