/** Barrel for the calendar actions: the `CALENDAR` action runner factory, its LLM plan extractor, and the shared plan-instruction constant. */
export {
  CALENDAR_PLAN_INSTRUCTIONS,
  type CalendarHandlerAction,
  type CalendarLlmPlan,
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "./calendar-handler.js";
export type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
  CalendarTravelBufferDep,
  CalendarTravelBufferResult,
  CalendarTravelIntent,
} from "./deps.js";
