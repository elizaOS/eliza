/** Exercises CAL-16 clarification and exact persisted rescheduling with a live model. */
import { calendarDstClarificationJourney } from "../../../support/helpers/calendar-dst-clarification.js";

export default calendarDstClarificationJourney({
  id: "calendar.reschedule.dst-clarification-fold-later",
  date: "2027-11-07",
  initialStart: "2027-11-07T16:00:00.000Z",
  initialEnd: "2027-11-07T16:15:00.000Z",
  requestedTime: "1:30 AM",
  clarificationRubric:
    "The assistant must explain that 1:30 AM occurs twice on November 7, 2027 in America/Los_Angeles and ask whether the user wants the earlier or later occurrence. Those two labels sufficiently distinguish the choices; saying daylight-time, standard-time, or numeric offsets is optional. It must not choose an occurrence or claim the event was moved.",
  choice:
    "Use the later occurrence of 1:30 AM, UTC-08:00, in America/Los_Angeles on November 7, 2027. Yes, move Cedar review there and keep it 15 minutes.",
  expectedStart: "2027-11-07T09:30:00.000Z",
  expectedEnd: "2027-11-07T09:45:00.000Z",
});
