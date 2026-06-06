export { ownerAlarmsAction } from "./actions/alarms.ts";
export { ownerGoalsAction } from "./actions/goals.ts";
export { ownerRemindersAction } from "./actions/reminders.ts";
export { ownerRoutinesAction } from "./actions/routines.ts";
export {
  type AlarmInsert,
  type AlarmRow,
  alarmsTable,
  type CheckinInsert,
  type CheckinRow,
  checkinsTable,
  type GoalInsert,
  type GoalRow,
  goalsSchema,
  goalsTable,
  type ReminderInsert,
  type ReminderRow,
  remindersTable,
  type RoutineInsert,
  type RoutineRow,
  routinesTable,
} from "./db/schema.ts";
export { default, goalsPlugin } from "./plugin.ts";
export { getGoalsCheckinService, GoalsCheckinService } from "./services/checkin.ts";
export * from "./types.ts";

// View export — re-exported so host applications can pre-render the view
// without going through the dynamic bundle loader.
export { GoalsView } from "./components/goals/GoalsView.tsx";
