/**
 * LifeOpsPageView — the chief-of-staff brief hub.
 *
 * A real data-fetching view over `GET {base}/api/lifeops/overview` (the
 * canonical `getOverview()` read that projects the scheduling spine). It renders
 * the owner's prioritized day (active + overdue occurrences), active reminders,
 * goals, and the circadian/schedule hint — the cross-domain aggregation the PA
 * README reserves as the hub. Light, minimal, chat-forward: the floating chat is
 * the input, so the view stays glanceable and defers actions to the agent.
 *
 * The default fetcher builds the URL from `client.getBaseUrl()`; tests inject a
 * `fetchOverview` seam so they stay offline. The TUI view is unchanged.
 */

import { client, TerminalPluginView } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  LifeOpsActiveReminderView,
  LifeOpsGoalDefinition,
  LifeOpsOccurrenceState,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
} from "@elizaos/shared";
// NOTE: only import lucide icons the host app already ships. View bundles
// externalize `lucide-react` and the host tree-shakes it to the icons it
// statically uses, so an icon nothing else references resolves to `undefined`
// at runtime (React error #130). AlarmClock, for one, is NOT shipped.
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCircle2,
  ListChecks,
  RefreshCw,
  Target,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface LifeOpsPageViewProps {
  /** Test/host injection seam. Defaults to a real `/api/lifeops/overview` GET. */
  fetchOverview?: () => Promise<LifeOpsOverview>;
}

async function defaultFetchOverview(): Promise<LifeOpsOverview> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/overview`);
  if (!response.ok) {
    throw new Error(`LifeOps overview request failed (${response.status}).`);
  }
  return (await response.json()) as LifeOpsOverview;
}

const ACCENT = "var(--accent, #ff8a24)";
const DANGER = "var(--danger, #f6465d)";
const MUTED = "var(--muted, rgba(6, 19, 31, 0.58))";

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 20,
  padding: 24,
  paddingBottom: 120,
  minHeight: "100%",
  boxSizing: "border-box",
  background: "var(--bg, #eef8ff)",
  color: "var(--txt, #1e2329)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const h1Style: CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const statsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 20,
};

const sectionLabelStyle: CSSProperties = {
  margin: "4px 0 8px",
  fontSize: 13,
  fontWeight: 500,
  color: MUTED,
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
  alignItems: "center",
  gap: 12,
  padding: "10px 4px",
  borderBottom: "1px solid var(--border, rgba(6, 19, 31, 0.08))",
};

const dimStyle: CSSProperties = { fontSize: 13, color: MUTED };

const iconBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 36,
  width: 36,
  borderRadius: 10,
  border: "none",
  background: "transparent",
  color: MUTED,
  cursor: "pointer",
};

/** Color for an occurrence state dot — overdue/visible orange, done green, else neutral. */
function stateDotColor(state: LifeOpsOccurrenceState, overdue: boolean): string {
  if (state === "completed") return "var(--ok, #03a66d)";
  if (overdue) return DANGER;
  if (state === "visible" || state === "pending") return ACCENT;
  return MUTED;
}

function isOverdue(occurrence: LifeOpsOccurrenceView): boolean {
  if (!occurrence.dueAt) return false;
  if (occurrence.state === "completed" || occurrence.state === "skipped") {
    return false;
  }
  return new Date(occurrence.dueAt).getTime() < Date.now();
}

function formatDue(dueAt: string | null): string {
  if (!dueAt) return "";
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Sort the owner's day: overdue first, then by due time, undated last. */
function sortOccurrences(
  occurrences: LifeOpsOccurrenceView[],
): LifeOpsOccurrenceView[] {
  return [...occurrences].sort((a, b) => {
    const aOver = isOverdue(a) ? 0 : 1;
    const bOver = isOverdue(b) ? 0 : 1;
    if (aOver !== bOver) return aOver - bOver;
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}

function Stat({
  icon,
  count,
  label,
  emphasize,
}: {
  icon: ReactNode;
  count: number;
  label: string;
  emphasize?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: emphasize && count > 0 ? DANGER : ACCENT, display: "inline-flex" }}>
        {icon}
      </span>
      <span style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
      <span style={dimStyle}>{label}</span>
    </div>
  );
}

function RefreshButton({
  onActivate,
  busy,
}: {
  onActivate: () => void;
  busy: boolean;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "lifeops-refresh",
    role: "button",
    label: "Refresh brief",
    group: "lifeops-hub",
    description: "Reload the owner's LifeOps brief (priorities, reminders, goals)",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      style={iconBtnStyle}
      onClick={onActivate}
      disabled={busy}
      aria-label="Refresh brief"
      {...agentProps}
    >
      <RefreshCw size={18} className={busy ? "animate-spin" : undefined} aria-hidden />
    </button>
  );
}

function OccurrenceRow({ occurrence }: { occurrence: LifeOpsOccurrenceView }) {
  const overdue = isOverdue(occurrence);
  const due = formatDue(occurrence.dueAt);
  return (
    <li style={rowStyle} data-testid={`lifeops-occurrence-${occurrence.id}`}>
      <span
        aria-hidden
        style={{
          height: 8,
          width: 8,
          borderRadius: "50%",
          background: stateDotColor(occurrence.state, overdue),
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500 }}>
        {occurrence.title}
      </span>
      {due ? (
        <span style={{ ...dimStyle, color: overdue ? DANGER : MUTED }}>
          {overdue ? `Overdue · ${due}` : due}
        </span>
      ) : null}
    </li>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; overview: LifeOpsOverview };

export function LifeOpsPageView({ fetchOverview }: LifeOpsPageViewProps = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetchOverview ?? defaultFetchOverview);
  fetcherRef.current = fetchOverview ?? defaultFetchOverview;

  const load = useCallback((initial: boolean) => {
    if (initial) setState({ kind: "loading" });
    else setRefreshing(true);
    fetcherRef
      .current()
      .then((overview) => setState({ kind: "data", overview }))
      .catch((error: unknown) => {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Failed to load brief.",
        });
      })
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  if (state.kind === "loading") {
    return (
      <main style={containerStyle} data-testid="lifeops-loading">
        <h1 style={h1Style}>Brief</h1>
        <p style={dimStyle}>Loading your day…</p>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main style={containerStyle} data-testid="lifeops-error">
        <div style={headerRowStyle}>
          <h1 style={h1Style}>Brief</h1>
          <RefreshButton onActivate={() => load(true)} busy={refreshing} />
        </div>
        <p style={{ ...dimStyle, color: DANGER }}>{state.message}</p>
      </main>
    );
  }

  const { owner, schedule } = state.overview;
  const occurrences = sortOccurrences(owner.occurrences);
  const reminders: LifeOpsActiveReminderView[] = owner.reminders;
  const goals: LifeOpsGoalDefinition[] = owner.goals;
  const { summary } = owner;
  const nothingPending =
    occurrences.length === 0 && reminders.length === 0 && goals.length === 0;

  return (
    <main
      style={containerStyle}
      data-testid="lifeops-hub"
      data-view-state={JSON.stringify({
        active: summary.activeOccurrenceCount,
        overdue: summary.overdueOccurrenceCount,
        goals: summary.activeGoalCount,
        reminders: summary.activeReminderCount,
      })}
    >
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Brief</h1>
        <RefreshButton onActivate={() => load(false)} busy={refreshing} />
      </div>

      <div style={statsRowStyle} data-testid="lifeops-summary">
        <Stat icon={<ListChecks size={18} />} count={summary.activeOccurrenceCount} label="active" />
        <Stat icon={<AlertTriangle size={18} />} count={summary.overdueOccurrenceCount} label="overdue" emphasize />
        <Stat icon={<CalendarClock size={18} />} count={summary.activeReminderCount} label="reminders" />
        <Stat icon={<Target size={18} />} count={summary.activeGoalCount} label="goals" />
      </div>

      {schedule ? (
        <p style={dimStyle} data-testid="lifeops-schedule">
          {scheduleLine(schedule.circadianState)}
        </p>
      ) : null}

      {nothingPending ? (
        <div
          data-testid="lifeops-empty"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "48px 0", textAlign: "center" }}
        >
          <CheckCircle2 size={28} style={{ color: "var(--ok, #03a66d)" }} aria-hidden />
          <p style={{ margin: 0, fontWeight: 600 }}>Nothing needs you right now</p>
          <p style={dimStyle}>Ask Eliza to add a reminder, plan your day, or triage your inbox.</p>
        </div>
      ) : (
        <>
          {occurrences.length > 0 ? (
            <section data-testid="lifeops-today">
              <h2 style={sectionLabelStyle}>Today</h2>
              <ul style={listStyle}>
                {occurrences.map((occurrence) => (
                  <OccurrenceRow key={occurrence.id} occurrence={occurrence} />
                ))}
              </ul>
            </section>
          ) : null}

          {reminders.length > 0 ? (
            <section data-testid="lifeops-reminders">
              <h2 style={sectionLabelStyle}>Reminders</h2>
              <ul style={listStyle}>
                {reminders.map((reminder) => (
                  <li
                    key={`${reminder.ownerId}:${reminder.stepIndex}`}
                    style={rowStyle}
                    data-testid="lifeops-reminder"
                  >
                    <Bell size={15} style={{ color: ACCENT, flexShrink: 0 }} aria-hidden />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{reminder.title}</span>
                    <span style={dimStyle}>{reminder.stepLabel}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {goals.length > 0 ? (
            <section data-testid="lifeops-goals">
              <h2 style={sectionLabelStyle}>Goals</h2>
              <ul style={listStyle}>
                {goals.map((goal) => (
                  <li key={goal.id} style={rowStyle} data-testid="lifeops-goal">
                    <Target size={15} style={{ color: ACCENT, flexShrink: 0 }} aria-hidden />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{goal.title}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function scheduleLine(circadianState: string): string {
  switch (circadianState) {
    case "sleeping":
      return "Likely asleep — holding non-urgent nudges.";
    case "napping":
      return "Likely napping.";
    case "winding_down":
      return "Winding down for the day.";
    case "waking":
      return "Waking up — easing into the day.";
    case "awake":
      return "Awake and available.";
    default:
      return "Schedule unclear right now.";
  }
}

export function LifeOpsTuiView() {
  return (
    <TerminalPluginView
      id="lifeops"
      label="LifeOps TUI"
      description="Terminal personal assistant workspace for briefs, approvals, schedule repair, and owner operations"
      commands={["terminal-lifeops-state", "terminal-lifeops-enable"]}
      endpoints={[
        "/api/lifeops/overview",
        "/api/lifeops/inbox",
        "/api/lifeops/calendar/feed",
      ]}
    />
  );
}
