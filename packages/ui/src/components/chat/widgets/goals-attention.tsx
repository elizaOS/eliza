/**
 * Icon-first widget surfacing the single most-urgent LifeOps goal (see the
 * `GoalsAttentionWidget` JSDoc below).
 *
 * As of spec §B/§E item 5 this widget no longer holds a `slot:"home"`
 * declaration - the at-risk goal is absorbed into the home "Today" (todo) card
 * as one flagged row (todo.tsx). This component stays as the standalone,
 * routed-surface renderer; its data layer lives in `goals-attention-data.ts`
 * and is shared with the Today card so both stay in lock-step.
 */
import { Target } from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import {
  type AttentionGoal,
  attentionCount,
  GOALS_REFRESH_INTERVAL_MS,
  goalsEqual,
  loadGoalsForGlance,
  mostUrgentGoal,
} from "./goals-attention-data";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const GOALS_WIDGET_KEY = "goals/goals.attention";

/**
 * Frontpage Goals widget (#9143). Glanceable, icon-first: surfaces the SINGLE
 * most-urgent goal (at_risk first, then needs_attention) as one datum, with a
 * count badge. Fetches the same `/api/lifeops/goals` endpoint GoalsView reads
 * and floats itself up via the home-attention store when any goal is at risk or
 * needs attention. Tapping the card opens the Goals view. No longer a home
 * resident (§E item 5) - retained for the routed goals surface.
 */
export function GoalsAttentionWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  // `null` distinguishes "first load still pending" from "loaded, empty" so the
  // surface renders nothing (not a card) until we actually know the data.
  const [goals, setGoals] = useState<AttentionGoal[] | null>(null);
  const nav = useWidgetNavigation();
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 20s goals poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    const next = await loadGoalsForGlance(authenticated);
    // A null return means the fetch failed (J4) - keep the last good render.
    if (next == null) return;
    // Skip the state update (and the re-render) when the poll is unchanged.
    setGoals((prev) => (goalsEqual(prev, next) ? prev : next));
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
  // goal needs attention - the surface must not show empty placeholders or
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
