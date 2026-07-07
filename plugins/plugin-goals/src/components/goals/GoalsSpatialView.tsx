/**
 * GoalsSpatialView — the owner life-direction surface authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — the spatial primitives still render to terminal lines via
 *                `@elizaos/ui/spatial/tui`, but the plugin no longer ships a
 *                terminal registration (GUI-only view inventory).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus this plugin's own
 * display DTOs, so it is safe to render in the Node agent process where the
 * terminal lives (no browser/data-fetch import).
 *
 * The view is read-only: goals are owned by the personal-assistant routes and
 * created through the assistant chat, not mutated here. The only interactions
 * are the status-filter toggles, a Retry on the error state, and the "Set a
 * goal" chat affordance on the empty state.
 */

import { Button, Card, HStack, List, Text, VStack } from "@elizaos/ui/spatial";
import {
  GOAL_STATUSES,
  type GoalItem,
  type GoalReviewState,
  type GoalStatus,
} from "../../types.ts";

/** Coarse load state of the goals surface. */
export type GoalsLoadStatus = "loading" | "error" | "ready";

export interface GoalsSnapshot {
  /** Coarse load state. */
  status: GoalsLoadStatus;
  /** Goal records (empty until ready). */
  goals: GoalItem[];
  /** Active status filters; empty = show every status. */
  activeStatuses: GoalStatus[];
  /** Error text when status is "error". */
  error?: string | null;
}

export interface GoalsSpatialViewProps {
  snapshot: GoalsSnapshot;
  /**
   * Dispatch by agent id: `retry` (re-fetch on the error state), `new` (ask the
   * assistant to set a goal), and `filter:<status>` (toggle one status chip,
   * status ∈ active|paused|archived|satisfied).
   */
  onAction?: (action: string) => void;
}

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  satisfied: "Achieved",
};

const REVIEW_LABELS: Record<GoalReviewState, string> = {
  idle: "not reviewed",
  on_track: "on track",
  at_risk: "at risk",
  needs_attention: "needs attention",
};

// Width-1 review marker — filled vs hollow vs cross, never emoji or a checkmark.
//   on_track       → ● (settled)
//   at_risk / needs_attention → x (flagged)
//   idle           → ○ (not yet reviewed)
const REVIEW_GLYPH: Record<GoalReviewState, string> = {
  idle: "○",
  on_track: "●",
  at_risk: "x",
  needs_attention: "x",
};

const REVIEW_TONE: Record<GoalReviewState, "muted" | "success" | "danger"> = {
  idle: "muted",
  on_track: "success",
  at_risk: "danger",
  needs_attention: "danger",
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// One quiet proactive line: count the goals whose last review flagged them
// (at_risk / needs_attention). Returns null when nothing is flagged so the line
// renders only on a real signal (never "0 goals").
function reviewNudge(goals: GoalItem[]): string | null {
  const flagged = goals.filter(
    (goal) =>
      goal.reviewState === "at_risk" || goal.reviewState === "needs_attention",
  ).length;
  if (flagged === 0) return null;
  return flagged === 1
    ? "1 goal needs a review."
    : `${flagged} goals need a review.`;
}

export function GoalsSpatialView({
  snapshot,
  onAction,
}: GoalsSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const active = new Set(snapshot.activeStatuses);

  return (
    <Card gap={1} padding={1}>
      {snapshot.status === "loading" ? (
        <Text tone="muted" style="caption">
          Loading goals
        </Text>
      ) : snapshot.status === "error" ? (
        <GoalsErrorBody error={snapshot.error} dispatch={dispatch} />
      ) : (
        <GoalsReadyBody
          snapshot={snapshot}
          active={active}
          dispatch={dispatch}
        />
      )}
    </Card>
  );
}

function GoalsErrorBody({
  error,
  dispatch,
}: {
  error?: string | null;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Could not load goals</Text>
      {error ? (
        <Text tone="muted" style="caption">
          {error}
        </Text>
      ) : null}
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function GoalsReadyBody({
  snapshot,
  active,
  dispatch,
}: {
  snapshot: GoalsSnapshot;
  active: Set<GoalStatus>;
  dispatch: (action: string) => () => void;
}) {
  const nudge = reviewNudge(snapshot.goals);

  if (snapshot.goals.length === 0) {
    return (
      <>
        <Text bold>None</Text>
        <HStack gap={1}>
          <Button agent="new" onPress={dispatch("new")}>
            Set a goal
          </Button>
        </HStack>
      </>
    );
  }

  // Group by status, dropping empty groups, then apply the active filter.
  const groups = GOAL_STATUSES.map((status) => ({
    status,
    goals: snapshot.goals.filter((goal) => goal.status === status),
  })).filter((group) => {
    if (group.goals.length === 0) return false;
    if (active.size === 0) return true;
    return active.has(group.status);
  });

  return (
    <>
      {nudge ? (
        <Text tone="muted" style="caption">
          {nudge}
        </Text>
      ) : null}

      <HStack gap={1} wrap>
        {GOAL_STATUSES.map((status) => (
          <Button
            key={status}
            variant={active.has(status) ? "solid" : "outline"}
            tone={active.has(status) ? "primary" : "default"}
            agent={`filter:${status}`}
            onPress={dispatch(`filter:${status}`)}
          >
            {STATUS_LABELS[status]}
          </Button>
        ))}
      </HStack>

      {groups.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          None
        </Text>
      ) : (
        groups.map((group) => (
          <GoalsStatusGroup key={group.status} group={group} />
        ))
      )}
    </>
  );
}

function GoalsStatusGroup({
  group,
}: {
  group: { status: GoalStatus; goals: GoalItem[] };
}) {
  return (
    <>
      <Text style="caption" tone="muted">
        {STATUS_LABELS[group.status]} ({group.goals.length})
      </Text>
      <List gap={0}>
        {group.goals.map((goal) => (
          <GoalRow key={goal.id} goal={goal} />
        ))}
      </List>
    </>
  );
}

function GoalRow({ goal }: { goal: GoalItem }) {
  const meta: string[] = [];
  if (goal.cadenceKind) meta.push(goal.cadenceKind);
  if (goal.target) meta.push(goal.target);
  if (goal.linkedCount > 0) meta.push(`${goal.linkedCount} linked`);

  return (
    <HStack gap={1} align="center">
      <Text tone={REVIEW_TONE[goal.reviewState]} wrap={false}>
        {REVIEW_GLYPH[goal.reviewState]}
      </Text>
      <VStack gap={0} grow={1}>
        <Text bold wrap={false}>
          {goal.title}
        </Text>
        {meta.length > 0 ? (
          <Text style="caption" tone="muted" wrap={false}>
            {meta.join(" · ")}
          </Text>
        ) : null}
      </VStack>
      <VStack gap={0}>
        <Text
          style="caption"
          tone={REVIEW_TONE[goal.reviewState]}
          wrap={false}
          align="end"
        >
          {REVIEW_LABELS[goal.reviewState]}
        </Text>
        <Text style="caption" tone="muted" wrap={false} align="end">
          {formatDate(goal.updatedAt)}
        </Text>
      </VStack>
    </HStack>
  );
}
