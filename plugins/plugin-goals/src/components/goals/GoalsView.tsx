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
 * instruments its refresh + status-filter controls through the agent surface so
 * the floating chat can drive them. The default fetcher builds its URL from
 * `client.getBaseUrl()`; tests inject the fetcher seam so they stay offline.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits
 * (LifeOpsGoalDefinition / LifeOpsGoalLink in @elizaos/shared).
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { RefreshCw } from "lucide-react";
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
  /** Owner display name shown in the header subtitle. */
  ownerName?: string;
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
// Styling — dark theme, CSS vars, orange accent only.
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
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border: 1px solid var(--primary, #ff6a00);
}
.goals-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
.goals-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.goals-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
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
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.goals-view-chip:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.goals-view-chip[aria-pressed="true"] {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border-color: var(--primary, #ff6a00);
}
.goals-view-chip[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
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
  background: "var(--background, #0a0a0a)",
  color: "var(--foreground, #f5f5f5)",
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
  padding: 16,
  borderRadius: 8,
  border: "1px solid var(--border, rgba(255,255,255,0.08))",
  background: "var(--surface, rgba(255,255,255,0.02))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const subtitleStyle: CSSProperties = { ...dimStyle, marginTop: 2 };

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
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.06))",
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
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const reviewDotStyle: CSSProperties = {
  color: "var(--primary, #ff6a00)",
  marginRight: 6,
};

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function RefreshButton({
  onActivate,
  disabled,
}: {
  onActivate: () => void;
  disabled: boolean;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "goals-refresh",
    role: "button",
    label: "Refresh goals",
    group: "goals-toolbar",
    description: "Reload the owner's goals, cadences, and review state",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="goals-view-btn goals-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh goals"
      {...agentProps}
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
    </button>
  );
}

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

function GoalsHeader({
  ownerName,
  refetch,
  busy,
}: {
  ownerName: string;
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Goals</h1>
        <RefreshButton onActivate={refetch} disabled={busy} />
      </div>
      <div style={subtitleStyle}>
        {`Long-horizon goals, cadences, and review state for ${ownerName}.`}
      </div>
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
  const atRisk =
    goal.reviewState === "at_risk" || goal.reviewState === "needs_attention";
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={titleStyle}>
          {atRisk ? (
            <span
              role="img"
              aria-label="Needs attention"
              style={reviewDotStyle}
            >
              ●
            </span>
          ) : null}
          {goal.title}
        </span>
        {goal.description ? (
          <span style={descStyle}>{goal.description}</span>
        ) : null}
        {meta.length > 0 ? (
          <span style={dimStyle}>{meta.join(" · ")}</span>
        ) : null}
      </span>
      <span style={metaStyle}>
        {REVIEW_LABELS[goal.reviewState]} · {formatDate(goal.updatedAt)}
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

export function GoalsView(props: GoalsViewProps = {}): ReactNode {
  useGoalsViewStyles();

  const ownerName = props.ownerName ?? "Owner";
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

  useEffect(() => load(), [load]);

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
        <GoalsHeader ownerName={ownerName} refetch={load} busy={true} />
        <StatusFilters active={activeStatuses} onToggle={toggleStatus} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading goals…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="goals-error">
        <GoalsHeader ownerName={ownerName} refetch={load} busy={false} />
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
        <GoalsHeader ownerName={ownerName} refetch={load} busy={false} />
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

  return (
    <div style={containerStyle} data-testid="goals-populated">
      <GoalsHeader ownerName={ownerName} refetch={load} busy={false} />
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
