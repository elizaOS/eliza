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
  "checkin",
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

// ---------------------------------------------------------------------------
// View display DTOs.
//
// `GoalsView` reads `GET {base}/api/lifeops/goals`, which returns
// `{ goals: LifeOpsGoalRecord[] }` where each record is
// `{ goal: LifeOpsGoalDefinition; links: LifeOpsGoalLink[] }`
// (see LifeOpsGoalDefinition / LifeOpsGoalLink in
// packages/shared/src/contracts/personal-assistant.ts, served by the
// `/api/lifeops/goals` branch of
// plugins/plugin-personal-assistant/src/routes/lifeops-routes.ts).
//
// These display DTOs are the flat shape the view renders after mapping each
// wire record at the fetch boundary. The wire DTOs themselves are declared
// locally inside GoalsView.tsx; this plugin MUST NOT import the PA contract
// types. The status / review-state literals below mirror the real enums
// (LIFEOPS_GOAL_STATUSES / LIFEOPS_REVIEW_STATES) by value.
// ---------------------------------------------------------------------------

/** Lifecycle status of a goal (mirrors LIFEOPS_GOAL_STATUSES by value). */
export const GOAL_STATUSES = [
  "active",
  "paused",
  "archived",
  "satisfied",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/** Progress signal a goal review assigns (mirrors LIFEOPS_REVIEW_STATES). */
export const GOAL_REVIEW_STATES = [
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
] as const;
export type GoalReviewState = (typeof GOAL_REVIEW_STATES)[number];

/** A goal flattened for display. Mapped from a `LifeOpsGoalRecord` at fetch. */
export interface GoalItem {
  id: string;
  title: string;
  /** Empty string when the goal carries no description. */
  description: string;
  status: GoalStatus;
  reviewState: GoalReviewState;
  /** Cadence kind (e.g. "daily" / "weekly"), or null when the goal is ad-hoc. */
  cadenceKind: string | null;
  /** Human-readable target / next-due from successCriteria, or null. */
  target: string | null;
  /** Count of linked occurrences / tasks / entities backing the goal. */
  linkedCount: number;
  /** ISO timestamp of the last update to the goal. */
  updatedAt: string;
}
