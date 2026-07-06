/**
 * Shared goals-attention data layer.
 *
 * The single most-urgent LifeOps goal is surfaced in two places now:
 *  - the routed Goals view still renders the standalone `GoalsAttentionWidget`
 *    (goals-attention.tsx), and
 *  - the home "Today" card (todo.tsx) absorbs the at-risk goal as one flagged
 *    row (spec §B/§E item 5 - goals loses its standalone home resident).
 *
 * To keep those two consumers in lock-step, the wire parsing + urgency
 * selection live here rather than duplicated in each. Kept dependency-light
 * (no React) so it can be unit-tested and reused without pulling in a widget.
 *
 * Wire shape mirrors the JSON served by the PA goals route and parsed in
 * plugins/plugin-goals/src/components/goals/GoalsView.tsx (GoalsWire /
 * GoalRecordWire / GoalDefinitionWire). The canonical record type is
 * LifeOpsGoalRecord (@elizaos/shared); the field literals below mirror
 * GoalStatus / GoalReviewState in plugins/plugin-goals/src/types.ts. We only
 * read the fields a glanceable surface needs.
 */

import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";

/** How often a home surface refreshes goals - matches GoalsView's 20s poll. */
export const GOALS_REFRESH_INTERVAL_MS = 20_000;

export type GoalStatus = "active" | "paused" | "archived" | "satisfied";
export type GoalReviewState =
  | "idle"
  | "needs_attention"
  | "on_track"
  | "at_risk";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  "active",
  "paused",
  "archived",
  "satisfied",
]);
const KNOWN_REVIEW_STATES: ReadonlySet<string> = new Set<GoalReviewState>([
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
]);

/** A goal flattened for a glanceable surface. Mapped from a wire record. */
export interface AttentionGoal {
  id: string;
  title: string;
  status: GoalStatus;
  reviewState: GoalReviewState;
}

function toStatus(value: unknown): GoalStatus {
  return typeof value === "string" && KNOWN_STATUSES.has(value)
    ? (value as GoalStatus)
    : "active";
}

function toReviewState(value: unknown): GoalReviewState {
  return typeof value === "string" && KNOWN_REVIEW_STATES.has(value)
    ? (value as GoalReviewState)
    : "idle";
}

/**
 * Validate + flatten the untrusted `{ goals: [{ goal, links }] }` payload at
 * the network boundary, dropping any record missing the fields we render.
 */
export function parseGoals(payload: unknown): AttentionGoal[] {
  if (typeof payload !== "object" || payload === null) return [];
  const records = (payload as { goals?: unknown }).goals;
  if (!Array.isArray(records)) return [];

  const goals: AttentionGoal[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const goal = (record as { goal?: unknown }).goal;
    if (typeof goal !== "object" || goal === null) continue;
    const { id, title, status, reviewState } = goal as {
      id?: unknown;
      title?: unknown;
      status?: unknown;
      reviewState?: unknown;
    };
    if (typeof id !== "string" || typeof title !== "string") continue;
    goals.push({
      id,
      title,
      status: toStatus(status),
      reviewState: toReviewState(reviewState),
    });
  }
  return goals;
}

export async function fetchGoals(): Promise<AttentionGoal[]> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/goals`);
  if (!response.ok) {
    throw new Error(`Goals request failed (${response.status})`);
  }
  return parseGoals(await response.json());
}

/** Goals that belong on a glance surface: live (non-archived, non-satisfied). */
export function liveGoals(goals: AttentionGoal[]): AttentionGoal[] {
  return goals.filter(
    (goal) => goal.status !== "archived" && goal.status !== "satisfied",
  );
}

/**
 * The single most-urgent goal: the first at_risk goal, otherwise the first
 * needs_attention goal, otherwise null. Ties broken by title so the surfaced
 * goal is deterministic across polls.
 */
export function mostUrgentGoal(goals: AttentionGoal[]): AttentionGoal | null {
  const live = liveGoals(goals);
  const byTitle = (left: AttentionGoal, right: AttentionGoal) =>
    left.title.localeCompare(right.title);
  const atRisk = live
    .filter((goal) => goal.reviewState === "at_risk")
    .sort(byTitle);
  if (atRisk.length > 0) return atRisk[0];
  const needsAttention = live
    .filter((goal) => goal.reviewState === "needs_attention")
    .sort(byTitle);
  if (needsAttention.length > 0) return needsAttention[0];
  return null;
}

/** Count of live goals that need attention (at_risk or needs_attention). */
export function attentionCount(goals: AttentionGoal[]): number {
  return liveGoals(goals).filter(
    (goal) =>
      goal.reviewState === "at_risk" || goal.reviewState === "needs_attention",
  ).length;
}

/** Shallow content equality so an unchanged 20s poll doesn't re-render. */
export function goalsEqual(
  a: AttentionGoal[] | null,
  b: AttentionGoal[],
): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((goal, i) => {
    const other = b[i];
    return (
      goal.id === other.id &&
      goal.title === other.title &&
      goal.status === other.status &&
      goal.reviewState === other.reviewState
    );
  });
}

/**
 * Best-effort goals fetch for a glance surface: honors the auth gate and the
 * limited-cloud-base guard, and swallows fetch errors (returns `null` so the
 * caller keeps its last-good render, todo.tsx J4 pattern). Returns `[]` when
 * gated so the caller resolves to "loaded, empty" rather than "still pending".
 */
export async function loadGoalsForGlance(
  authenticated: boolean,
): Promise<AttentionGoal[] | null> {
  if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
    return [];
  }
  try {
    return await fetchGoals();
  } catch {
    // error-policy:J4 glance surface - signal "keep last good" to the caller.
    return null;
  }
}
