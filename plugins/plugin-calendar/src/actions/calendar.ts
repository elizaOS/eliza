/** Canonical standalone Calendar action; host adapters are selected per runtime. */
import { createCalendarActionRunner } from "./calendar-handler.js";
import { standaloneCalendarDeps } from "./standalone-calendar-deps.js";
export const calendarAction = createCalendarActionRunner(
  standaloneCalendarDeps,
);
export default calendarAction;
