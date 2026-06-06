/**
 * Public types for @elizaos/plugin-goals.
 *
 * These mirror (and will eventually replace) the action contracts currently
 * declared inside `plugins/plugin-personal-assistant/src/actions/owner-surfaces.ts`.
 * During the decomposition phase the action handlers below remain stubs and
 * delegate (via TODO comments) to the LifeOps implementations.
 */

export const GOALS_CONTEXTS = ["goals", "self_care", "owner"] as const;
export type GoalsContext = (typeof GOALS_CONTEXTS)[number];

export const GOAL_ACTIONS = [
  "create",
  "update",
  "delete",
  "review",
] as const;
export type GoalActionName = (typeof GOAL_ACTIONS)[number];

export const ROUTINE_ACTIONS = [
  "create",
  "update",
  "delete",
  "complete",
  "skip",
  "snooze",
  "review",
] as const;
export type RoutineActionName = (typeof ROUTINE_ACTIONS)[number];

export const REMINDER_ACTIONS = [
  "create",
  "update",
  "delete",
  "complete",
  "snooze",
  "list",
] as const;
export type ReminderActionName = (typeof REMINDER_ACTIONS)[number];

export const ALARM_ACTIONS = [
  "create",
  "update",
  "delete",
  "snooze",
  "dismiss",
  "list",
] as const;
export type AlarmActionName = (typeof ALARM_ACTIONS)[number];

export interface GoalsScope {
  agentId: string;
  entityId: string;
  roomId?: string;
}

export const GOALS_CHECKIN_SERVICE_TYPE = "goals_checkin" as const;
export const GOALS_LOG_PREFIX = "[plugin-goals]" as const;
