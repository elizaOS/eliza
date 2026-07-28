/** Barrel for the calendar actions: calendar CRUD/planning plus deterministic conflict detection. */
export { calendarAction } from "./calendar.js";
export {
  CALENDAR_PLAN_INSTRUCTIONS,
  type CalendarHandlerAction,
  type CalendarLlmPlan,
  createCalendarActionRunner,
  extractCalendarPlanWithLlm,
} from "./calendar-handler.js";
export {
  type CalendarSourceConnectionIntent,
  type CalendarSourceOperation,
  calendarSourcesAction,
} from "./calendar-sources.js";
export {
  __resetConflictDetectLoaderForTests,
  type ConflictDetectActionDeps,
  type ConflictDetectEvent,
  type ConflictDetectHostAdapter,
  type ConflictDetectLoadBatch,
  type ConflictDetectLoader,
  type ConflictDetectLoadResult,
  type ConflictDetectLoadSnapshot,
  type ConflictDetectPair,
  type ConflictDetectProposal,
  type ConflictDetectResult,
  type ConflictRange,
  type ConflictSeverity,
  conflictDetectAction,
  createCalendarFeedConflictLoader,
  createConflictDetectAction,
  registerConflictDetectHostAdapter,
  setConflictDetectLoader,
} from "./conflict-detect.js";
export type {
  CalendarActionDeps,
  CalendarJsonModelResult,
  CalendarModelCallArgs,
  CalendarMutationApprovalResult,
  CalendarMutationCancelRequest,
  CalendarMutationGatewayDep,
  CalendarMutationUpdateRequest,
  CalendarTravelBufferDep,
  CalendarTravelBufferResult,
  CalendarTravelIntent,
} from "./deps.js";
