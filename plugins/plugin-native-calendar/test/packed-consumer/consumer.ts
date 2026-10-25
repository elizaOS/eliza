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
