/** Exercises CAL-16 clarification and exact persisted rescheduling with a live model. */
import { calendarDstClarificationJourney } from "../../../support/helpers/calendar-dst-clarification.js";

export default calendarDstClarificationJourney({
  id: "calendar.reschedule.dst-clarification-gap",
  date: "2027-03-14",
  initialStart: "2027-03-14T15:00:00.000Z",
  initialEnd: "2027-03-14T15:15:00.000Z",
  requestedTime: "2:30 AM",
  clarificationRubric:
    "The assistant must explain that 2:30 AM does not exist on March 14, 2027 in America/Los_Angeles and ask the user to choose a valid local time. It must not claim the event was moved or silently shift it to 3:30 AM.",
  choice:
    "Use 3:30 AM America/Los_Angeles on March 14, 2027 instead. Yes, move Cedar review to that time and keep it 15 minutes.",
  expectedStart: "2027-03-14T10:30:00.000Z",
  expectedEnd: "2027-03-14T10:45:00.000Z",
});
