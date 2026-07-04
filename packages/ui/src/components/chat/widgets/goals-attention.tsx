/**
 * Icon-first home widget surfacing the single most-urgent LifeOps goal (see the
 * `GoalsAttentionWidget` JSDoc below). One of the home-attention widget family
 * ({goals,inbox,finances,relationships,needs}-attention) that publish into the
 * shared home-attention store to rank themselves on the home surface.
 */
import { Target } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const GOALS_WIDGET_KEY = "goals/goals.attention";
const GOALS_REFRESH_INTERVAL_MS = 20_000; // matches GoalsView's 20s background poll

// ---------------------------------------------------------------------------
// Wire shape — mirrors the JSON served by the PA goals route and parsed in
// plugins/plugin-goals/src/components/goals/GoalsView.tsx (GoalsWire /
// GoalRecordWire / GoalDefinitionWire). The canonical record type is
// LifeOpsGoalRecord (@elizaos/shared); the field literals below mirror
// GoalStatus / GoalReviewState in plugins/plugin-goals/src/types.ts. We only
// read the fields this glanceable widget needs.
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "archived" | "satisfied";
type GoalReviewState = "idle" | "needs_attention" | "on_track" | "at_risk";

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

/** A goal flattened for the home widget. Mapped from a wire record at fetch. */
interface AttentionGoal {
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
function parseGoals(payload: unknown): AttentionGoal[] {
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

async function fetchGoals(): Promise<AttentionGoal[]> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/goals`);
  if (!response.ok) {
    throw new Error(`Goals request failed (${response.status})`);
  }
  return parseGoals(await response.json());
}

/** Goals that belong on the home card: live (non-archived, non-satisfied). */
function liveGoals(goals: AttentionGoal[]): AttentionGoal[] {
  return goals.filter(
    (goal) => goal.status !== "archived" && goal.status !== "satisfied",
  );
}

/**
 * The single most-urgent goal for the home card: the first at_risk goal,
 * otherwise the first needs_attention goal, otherwise null. Ties broken by
 * title so the surfaced goal is deterministic across polls.
 */
function mostUrgentGoal(goals: AttentionGoal[]): AttentionGoal | null {
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
function attentionCount(goals: AttentionGoal[]): number {
  return liveGoals(goals).filter(
    (goal) =>
      goal.reviewState === "at_risk" || goal.reviewState === "needs_attention",
  ).length;
}

/** Shallow content equality so an unchanged 20s poll doesn't re-render. */
function goalsEqual(a: AttentionGoal[] | null, b: AttentionGoal[]): boolean {
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
 * Frontpage Goals widget (#9143). Glanceable, home-only, icon-first: surfaces
 * the SINGLE most-urgent goal (at_risk first, then needs_attention) as one
 * datum, with a count badge. Fetches the same `/api/lifeops/goals` endpoint
 * GoalsView reads and floats itself up via the home-attention store when any
 * goal is at risk or needs attention. Tapping the card opens the Goals view.
 */
export function GoalsAttentionWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  // `null` distinguishes "first load still pending" from "loaded, empty" so the
  // home surface renders nothing (not a card) until we actually know the data.
  const [goals, setGoals] = useState<AttentionGoal[] | null>(null);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 20s goals poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      setGoals([]);
      return;
    }

    try {
      const next = await fetchGoals();
      // Skip the state update (and the re-render) when the poll is unchanged.
      setGoals((prev) => (goalsEqual(prev, next) ? prev : next));
    } catch {
      // Silent fallback to the last good render (matches todo.tsx); never log.
    }
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  // Poll only while the document is visible, at the View's 20s cadence.
  useIntervalWhenDocumentVisible(() => void load(), GOALS_REFRESH_INTERVAL_MS);

  const urgent = useMemo(() => (goals ? mostUrgentGoal(goals) : null), [goals]);
  const count = useMemo(() => (goals ? attentionCount(goals) : 0), [goals]);

  // Float the home card up while any goal is at risk / needs attention.
  usePublishHomeAttention(
    GOALS_WIDGET_KEY,
    urgent ? HOME_SIGNAL_WEIGHTS.escalation : null,
  );

  // Render nothing until the first load resolves, and nothing once loaded if no
  // goal needs attention — the home surface must not show empty placeholders or
  // on-track goals (#9143).
  if (goals == null || urgent == null) return null;

  const tone = urgent.reviewState === "at_risk" ? "danger" : "warn";
  const status =
    urgent.reviewState === "at_risk" ? "at risk" : "needs attention";

  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<Target />}
        label="Goals"
        value={urgent.title}
        badge={count > 1 ? `${count}` : undefined}
        tone={tone}
        testId="widget-goals-attention"
        ariaLabel={`Goals: ${count} need attention, top "${urgent.title}" ${status}. Open Goals.`}
        onActivate={() => nav.openView("/goals", "goals")}
      />
    </div>
  );
}

export const GOALS_HOME_WIDGET = {
  pluginId: "goals",
  id: "goals.attention",
  order: 120,
  signalKinds: ["escalation", "reminder"],
  Component: GoalsAttentionWidget satisfies ComponentType<WidgetProps>,
} as const;
