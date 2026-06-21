/**
 * GoalsView — owner life-direction surface.
 *
 * Data-fetching view over the single read-only goals endpoint served by the
 * personal-assistant routes (PA owns the persistence; this plugin only renders):
 *   GET {base}/api/lifeops/goals
 *
 * The wire payload is `{ goals: LifeOpsGoalRecord[] }`, where each record is
 * `{ goal: LifeOpsGoalDefinition; links: LifeOpsGoalLink[] }`. We flatten each
 * record to a `GoalItem` at the fetch boundary so the rest of the view renders
 * display-only.
 *
 * It renders one of four distinct states (loading, error, empty, populated) and
 * instruments its status-filter chips through the agent surface so the floating
 * chat can drive them. The view has no subscription, so a quiet 20s poll keeps
 * it fresh (no manual refresh control). The default fetcher reads from
 * `client.getBaseUrl()`; tests inject the fetcher seam so they stay offline.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits
 * (LifeOpsGoalDefinition / LifeOpsGoalLink in @elizaos/shared).
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GOAL_STATUSES,
  type GoalItem,
  type GoalReviewState,
  type GoalStatus,
} from "../../types.ts";

// ---------------------------------------------------------------------------
// Wire DTOs — local mirror of the JSON shape served by the PA goals route.
// Never import PA / @elizaos/shared goal types here; keep this view's contract
// self-contained and aligned by shape.
// ---------------------------------------------------------------------------

interface GoalDefinitionWire {
  id: string;
  title: string;
  description: string;
  cadence: Record<string, unknown> | null;
  successCriteria: Record<string, unknown>;
  status: string;
  reviewState: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface GoalLinkWire {
  id: string;
  goalId: string;
  linkedType: string;
  linkedId: string;
}

interface GoalRecordWire {
  goal: GoalDefinitionWire;
  links: GoalLinkWire[];
}

interface GoalsWire {
  goals: GoalRecordWire[];
}

// ---------------------------------------------------------------------------
// Fetcher seam — default to a real GET; tests inject an offline fake.
// ---------------------------------------------------------------------------

export interface GoalsFetchers {
  fetchGoals: () => Promise<GoalsWire>;
}

async function getGoals(): Promise<GoalsWire> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/goals`);
  if (!response.ok) {
    throw new Error(`Goals request failed (${response.status})`);
  }
  return (await response.json()) as GoalsWire;
}

const defaultFetchers: GoalsFetchers = {
  fetchGoals: getGoals,
};

export interface GoalsViewProps {
  /** Test/host injection seam. Defaults to the real `/api/lifeops/goals` GET. */
  fetchers?: GoalsFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping.
// ---------------------------------------------------------------------------

const KNOWN_STATUSES: ReadonlySet<string> = new Set(GOAL_STATUSES);
const KNOWN_REVIEW_STATES: ReadonlySet<string> = new Set([
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
]);

/** Coerce an unknown wire status to a known one; unknowns settle to "active". */
function toStatus(value: string): GoalStatus {
  return KNOWN_STATUSES.has(value) ? (value as GoalStatus) : "active";
}

/** Coerce an unknown wire review state; unknowns settle to "idle". */
function toReviewState(value: string): GoalReviewState {
  return KNOWN_REVIEW_STATES.has(value) ? (value as GoalReviewState) : "idle";
}

/** The cadence record carries a `kind` discriminator when present. */
function readCadenceKind(
  cadence: Record<string, unknown> | null,
): string | null {
  if (cadence && typeof cadence.kind === "string" && cadence.kind.length > 0) {
    return cadence.kind;
  }
  return null;
}

/**
 * successCriteria is a free-form record. We surface a human-readable target
 * only when it carries one of the conventional fields, otherwise null. Display
 * only — no derivation or math.
 */
function readTarget(criteria: Record<string, unknown>): string | null {
  const candidate =
    criteria.targetText ??
    criteria.target ??
    criteria.summary ??
    criteria.deadline ??
    criteria.dueAt;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  if (typeof candidate === "number") return String(candidate);
  return null;
}

function mapGoal(record: GoalRecordWire): GoalItem {
  const { goal, links } = record;
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description ?? "",
    status: toStatus(goal.status),
    reviewState: toReviewState(goal.reviewState),
    cadenceKind: readCadenceKind(goal.cadence),
    target: readTarget(goal.successCriteria ?? {}),
    linkedCount: links.length,
    updatedAt: goal.updatedAt,
  };
}

const STATUS_LABELS: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  satisfied: "Achieved",
};

const REVIEW_LABELS: Record<GoalReviewState, string> = {
  idle: "Not reviewed",
  on_track: "On track",
  at_risk: "At risk",
  needs_attention: "Needs attention",
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

// ---------------------------------------------------------------------------
// Styling — light surface, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "goals-view-styles";

const GOALS_VIEW_CSS = `
.goals-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.goals-view-btn-primary {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #ffffff);
  border: 1px solid var(--primary, #ff8a24);
}
.goals-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 85%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 85%, black);
}
.goals-view-btn-neutral {
  background: transparent;
  color: var(--foreground, #0a0a0a);
  border: 1px solid var(--border, rgba(10, 10, 10, 0.12));
}
.goals-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #0a0a0a) 6%, transparent);
}
.goals-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.goals-view-chip {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  padding: 0 16px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
  background: transparent;
  color: var(--foreground, #0a0a0a);
  border: 1px solid var(--border, rgba(10, 10, 10, 0.12));
}
.goals-view-chip:hover {
  background: color-mix(in srgb, var(--foreground, #0a0a0a) 6%, transparent);
}
.goals-view-chip[aria-pressed="true"] {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #ffffff);
  border-color: var(--primary, #ff8a24);
}
.goals-view-chip[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 85%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 85%, black);
}
`;

function useGoalsViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = GOALS_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "var(--background, #eef8ff)",
  color: "var(--foreground, #0a0a0a)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };

const cardStyle: CSSProperties = {
  padding: "8px 0",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "10px 0",
  borderBottom: "1px solid var(--border, rgba(10,10,10,0.08))",
  fontSize: 14,
};

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const titleStyle: CSSProperties = { fontWeight: 600 };

const descStyle: CSSProperties = {
  ...dimStyle,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const metaStyle: CSSProperties = {
  ...dimStyle,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

// One colored pill per row carries the review state. Red = at risk / needs
// attention, muted green = on track, neutral gray = idle. Orange is reserved
// for "busy", so it is never used here.
const REVIEW_PILL_COLORS: Record<GoalReviewState, { bg: string; fg: string }> =
  {
    idle: { bg: "rgba(10, 10, 10, 0.06)", fg: "rgba(10, 10, 10, 0.6)" },
    on_track: { bg: "rgba(34, 134, 73, 0.12)", fg: "#1f7a44" },
    at_risk: { bg: "rgba(239, 68, 68, 0.12)", fg: "#c23b3b" },
    needs_attention: { bg: "rgba(239, 68, 68, 0.12)", fg: "#c23b3b" },
  };

function reviewPillStyle(state: GoalReviewState): CSSProperties {
  const { bg, fg } = REVIEW_PILL_COLORS[state];
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    color: fg,
    whiteSpace: "nowrap",
  };
}

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function StatusChip({
  status,
  label,
  active,
  onToggle,
}: {
  status: GoalStatus;
  label: string;
  active: boolean;
  onToggle: (status: GoalStatus) => void;
}): ReactNode {
  const activate = useCallback(() => onToggle(status), [status, onToggle]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `goals-status-${status}`,
    role: "toggle",
    label: `${label} status filter`,
    group: "goals-status-filters",
    description: `Show only ${label} goals`,
    status: active ? "active" : "inactive",
    onActivate: activate,
  });
  return (
    // The visible label IS the accessible name (no aria-label) so command->view
    // routing can address the chip by its status name (e.g. "Active").
    <button
      ref={ref}
      type="button"
      className="goals-view-chip"
      onClick={activate}
      aria-pressed={active}
      {...agentProps}
    >
      {label}
    </button>
  );
}

function GoalsHeader(): ReactNode {
  return (
    <header style={headerRowStyle}>
      <h1 style={h1Style}>Goals</h1>
    </header>
  );
}

function StatusFilters({
  active,
  onToggle,
}: {
  active: ReadonlySet<GoalStatus>;
  onToggle: (status: GoalStatus) => void;
}): ReactNode {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an ARIA group of filter-chip toggles, not a form fieldset
    <div
      role="group"
      aria-label="Status filters"
      style={chipRowStyle}
      data-testid="goals-status-filters"
    >
      {GOAL_STATUSES.map((status) => (
        <StatusChip
          key={status}
          status={status}
          label={STATUS_LABELS[status]}
          active={active.has(status)}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function GoalRow({ goal }: { goal: GoalItem }): ReactNode {
  const meta: string[] = [];
  if (goal.cadenceKind) meta.push(goal.cadenceKind);
  if (goal.target) meta.push(goal.target);
  if (goal.linkedCount > 0) {
    meta.push(`${goal.linkedCount} linked`);
  }
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={titleStyle}>{goal.title}</span>
        {goal.description ? (
          <span style={descStyle}>{goal.description}</span>
        ) : null}
        {meta.length > 0 ? (
          <span style={dimStyle}>{meta.join(" · ")}</span>
        ) : null}
      </span>
      <span style={metaStyle}>
        <span style={reviewPillStyle(goal.reviewState)}>
          {REVIEW_LABELS[goal.reviewState]}
        </span>{" "}
        {formatDate(goal.updatedAt)}
      </span>
    </li>
  );
}

function StatusGroup({
  status,
  goals,
}: {
  status: GoalStatus;
  goals: GoalItem[];
}): ReactNode {
  return (
    <div style={cardStyle} data-testid={`goals-group-${status}`}>
      <h2 style={h2Style}>
        {STATUS_LABELS[status]} <span style={dimStyle}>({goals.length})</span>
      </h2>
      <ul style={listStyle} aria-label={`${STATUS_LABELS[status]} goals`}>
        {goals.map((goal) => (
          <GoalRow key={goal.id} goal={goal} />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; goals: GoalItem[] };

function requestNewGoal(): void {
  client.sendChatMessage?.("Help me set a goal to head toward this quarter.");
}

// DESIGN LAW 10 — one quiet proactive line under the title. Counts the goals
// whose last review flagged them (at_risk / needs_attention); these are the
// only review states that call for owner attention. Returns null when nothing
// is flagged so the line renders only on a real signal (never "0 goals").
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

export function GoalsView(props: GoalsViewProps = {}): ReactNode {
  useGoalsViewStyles();

  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [activeStatuses, setActiveStatuses] = useState<Set<GoalStatus>>(
    () => new Set<GoalStatus>(),
  );

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchersRef.current
      .fetchGoals()
      .then((wire) => {
        if (cancelled) return;
        setState({ kind: "ready", goals: wire.goals.map(mapGoal) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not load goals.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial fetch on mount, then a quiet 20s background poll keeps the list
  // fresh (the view has no store subscription and there is no manual refresh).
  // The poll refetches silently: it never drops to the loading skeleton and a
  // transient poll failure leaves the current data on screen.
  useEffect(() => {
    const cancelInitial = load();
    let active = true;
    const interval = setInterval(() => {
      fetchersRef.current
        .fetchGoals()
        .then((wire) => {
          if (active)
            setState({ kind: "ready", goals: wire.goals.map(mapGoal) });
        })
        .catch(() => {
          /* keep the last good render on a transient poll failure */
        });
    }, 20000);
    return () => {
      active = false;
      clearInterval(interval);
      cancelInitial();
    };
  }, [load]);

  const toggleStatus = useCallback((status: GoalStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  // Filtering is presentation-only (the route returns the full goal set), so it
  // derives from the ready goals + active selection. The active set is the
  // single source of truth, so the chips and the rendered groups never disagree.
  const groups = useMemo(() => {
    if (state.kind !== "ready") return [];
    return GOAL_STATUSES.map((status) => ({
      status,
      goals: state.goals.filter((goal) => goal.status === status),
    })).filter((group) => {
      if (group.goals.length === 0) return false;
      if (activeStatuses.size === 0) return true;
      return activeStatuses.has(group.status);
    });
  }, [state, activeStatuses]);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="goals-loading">
        <GoalsHeader />
        <StatusFilters active={activeStatuses} onToggle={toggleStatus} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading goals…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="goals-error">
        <GoalsHeader />
        <StatusFilters active={activeStatuses} onToggle={toggleStatus} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load goals</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="goals-view-btn goals-view-btn-primary"
              onClick={load}
              aria-label="Retry loading goals"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Fetched OK but no goals exist yet → honest set-a-goal affordance routed
  // through the assistant chat. No fabricated goals.
  if (state.goals.length === 0) {
    return (
      <div style={containerStyle} data-testid="goals-empty">
        <GoalsHeader />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No goals yet</div>
          <div style={dimStyle}>
            Nothing to track yet. Ask Eliza to set a goal — tell her what you
            want to head toward this quarter and she’ll keep you on it.
          </div>
          <div>
            <button
              type="button"
              className="goals-view-btn goals-view-btn-primary"
              onClick={requestNewGoal}
              aria-label="Ask Eliza to set a goal"
            >
              Set a goal
            </button>
          </div>
        </div>
      </div>
    );
  }

  const nudge = reviewNudge(state.goals);

  return (
    <div style={containerStyle} data-testid="goals-populated">
      <GoalsHeader />
      {nudge ? (
        <div style={dimStyle} data-testid="goals-review-nudge">
          {nudge}
        </div>
      ) : null}
      <StatusFilters active={activeStatuses} onToggle={toggleStatus} />
      {groups.length > 0 ? (
        <section style={sectionStyle} aria-label="Goals">
          {groups.map((group) => (
            <StatusGroup
              key={group.status}
              status={group.status}
              goals={group.goals}
            />
          ))}
        </section>
      ) : (
        <div style={{ ...cardStyle, ...dimStyle }}>
          No goals match the selected status filters.
        </div>
      )}
    </div>
  );
}

export default GoalsView;
