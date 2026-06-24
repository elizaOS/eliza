import { Target } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { Badge } from "../../ui/badge";
import { WidgetSection } from "./shared";

const GOALS_WIDGET_KEY = "goals/goals.attention";
const GOALS_REFRESH_INTERVAL_MS = 20_000; // matches GoalsView's 20s background poll
const MAX_VISIBLE_GOALS = 5;

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

/** Sort order on the home card: at_risk → needs_attention → other active. */
const REVIEW_RANK: Readonly<Record<GoalReviewState, number>> = {
  at_risk: 0,
  needs_attention: 1,
  on_track: 2,
  idle: 3,
};

/** Goals that belong on the home card: live (non-archived, non-satisfied). */
function liveGoals(goals: AttentionGoal[]): AttentionGoal[] {
  return goals.filter(
    (goal) => goal.status !== "archived" && goal.status !== "satisfied",
  );
}

/** Attention-first: at_risk, then needs_attention, then the rest by title. */
function sortForWidget(goals: AttentionGoal[]): AttentionGoal[] {
  return [...goals].sort((left, right) => {
    const byReview =
      REVIEW_RANK[left.reviewState] - REVIEW_RANK[right.reviewState];
    if (byReview !== 0) return byReview;
    return left.title.localeCompare(right.title);
  });
}

function isUrgent(goal: AttentionGoal): boolean {
  return (
    goal.reviewState === "at_risk" || goal.reviewState === "needs_attention"
  );
}

const REVIEW_BADGE_LABEL: Readonly<Record<GoalReviewState, string | null>> = {
  at_risk: "At risk",
  needs_attention: "Needs attention",
  on_track: "On track",
  idle: null,
};

function GoalRow({ goal }: { goal: AttentionGoal }) {
  const badgeLabel = REVIEW_BADGE_LABEL[goal.reviewState];
  const urgent = isUrgent(goal);
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
          urgent
            ? "bg-danger"
            : goal.status === "active"
              ? "bg-accent"
              : "bg-muted"
        }`}
      />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
        {goal.title}
      </span>
      {badgeLabel ? (
        <Badge
          variant="secondary"
          className={`shrink-0 text-3xs ${urgent ? "text-danger" : ""}`}
        >
          {badgeLabel}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * Frontpage Goals widget (#9143). Glanceable, home-only: surfaces the goals
 * needing attention (at_risk / needs_attention first), one line each. Fetches
 * the same `/api/lifeops/goals` endpoint GoalsView reads and floats itself up
 * via the home-attention store when any goal is at risk or needs attention.
 */
export function GoalsAttentionWidget(_props: Partial<WidgetProps>) {
  const [goals, setGoals] = useState<AttentionGoal[]>([]);
  // Distinguish "first load still pending" from "loaded, empty" so the home
  // surface renders nothing (not a card) until we actually know there's data.
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchGoals();
      setGoals(next);
    } catch {
      // Silent fallback to the last good render (matches todo.tsx); never log.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Poll only while the document is visible, at the View's 20s cadence.
  useIntervalWhenDocumentVisible(() => void load(), GOALS_REFRESH_INTERVAL_MS);

  const visible = sortForWidget(liveGoals(goals));
  const hasUrgent = visible.some(isUrgent);

  // Float the home card up while any goal is at risk / needs attention.
  usePublishHomeAttention(
    GOALS_WIDGET_KEY,
    hasUrgent ? HOME_SIGNAL_WEIGHTS.escalation : null,
  );

  // Render nothing until the first load resolves, and nothing once loaded if
  // there are no live goals — the home surface must not show empty placeholders
  // (#9143).
  if (!loaded || visible.length === 0) return null;

  const rows = visible.slice(0, MAX_VISIBLE_GOALS);

  return (
    <WidgetSection
      title="Goals"
      icon={<Target className="h-4 w-4" />}
      testId="widget-goals-attention"
    >
      <div className="flex flex-col gap-0.5">
        {rows.map((goal) => (
          <GoalRow key={goal.id} goal={goal} />
        ))}
      </div>
    </WidgetSection>
  );
}

export const GOALS_HOME_WIDGET = {
  pluginId: "goals",
  id: "goals.attention",
  order: 120,
  signalKinds: ["escalation", "reminder"],
  Component: GoalsAttentionWidget satisfies ComponentType<WidgetProps>,
} as const;
