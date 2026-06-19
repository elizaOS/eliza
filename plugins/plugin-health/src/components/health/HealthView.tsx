/**
 * HealthView — overlay view for the Health / sleep app.
 *
 * Data-fetching view over the three read-only sleep endpoints served by
 * `src/routes/sleep.ts`:
 *   GET {base}/api/lifeops/sleep/history?windowDays&includeNaps   (primary)
 *   GET {base}/api/lifeops/sleep/regularity?windowDays&includeNaps (enrich)
 *   GET {base}/api/lifeops/sleep/baseline?windowDays               (enrich)
 *
 * It renders one of four distinct states (loading, error, empty, populated)
 * and instruments its window-range control and refresh button through the
 * agent surface so the floating chat can drive them.
 *
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seams so they stay offline.
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsRegularityClass,
  LifeOpsSleepHistoryEpisode,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "../../contracts/health.js";

// ---------------------------------------------------------------------------
// Fetcher seams — default to real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface SleepFetchers {
  fetchHistory: (windowDays: number) => Promise<LifeOpsSleepHistoryResponse>;
  fetchRegularity: (
    windowDays: number,
  ) => Promise<LifeOpsSleepRegularityResponse>;
  fetchBaseline: (
    windowDays: number,
  ) => Promise<LifeOpsPersonalBaselineResponse>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Sleep request failed (${response.status}): ${path}`);
  }
  return (await response.json()) as T;
}

const defaultFetchers: SleepFetchers = {
  fetchHistory: (windowDays) =>
    getJson<LifeOpsSleepHistoryResponse>(
      `/api/lifeops/sleep/history?windowDays=${windowDays}&includeNaps=true`,
    ),
  fetchRegularity: (windowDays) =>
    getJson<LifeOpsSleepRegularityResponse>(
      `/api/lifeops/sleep/regularity?windowDays=${windowDays}`,
    ),
  fetchBaseline: (windowDays) =>
    getJson<LifeOpsPersonalBaselineResponse>(
      `/api/lifeops/sleep/baseline?windowDays=${windowDays}`,
    ),
};

export interface HealthViewProps {
  /** Owner display name shown in the header subtitle. */
  ownerName?: string;
  /** Test/host injection seam. Defaults to real `/api/lifeops/sleep/*` GETs. */
  fetchers?: SleepFetchers;
  /** Initial look-back window in days. Defaults to 14. */
  initialWindowDays?: WindowDays;
}

export type WindowDays = 7 | 14 | 30;
const WINDOW_OPTIONS: readonly WindowDays[] = [7, 14, 30];

// ---------------------------------------------------------------------------
// Styling — dark theme, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "health-view-styles";

const HEALTH_VIEW_CSS = `
.health-view-btn {
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
.health-view-btn-primary {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border: 1px solid var(--primary, #ff6a00);
}
.health-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
.health-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.health-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.health-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.health-view-range-btn {
  min-height: 44px;
  min-width: 44px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  transition: background-color 120ms ease, border-color 120ms ease;
}
.health-view-range-btn:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.health-view-range-btn[aria-pressed="true"] {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border-color: var(--primary, #ff6a00);
}
.health-view-range-btn[aria-pressed="true"]:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
`;

function useHealthViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = HEALTH_VIEW_CSS;
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
const h2Style: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };

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

const statRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 14,
};

const statLabelStyle: CSSProperties = { opacity: 0.65 };
const statValueStyle: CSSProperties = { fontWeight: 600 };

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
};

const subtitleStyle: CSSProperties = { ...dimStyle, marginTop: 2 };

const visuallyHiddenStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
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
    id: "health-refresh",
    role: "button",
    label: "Refresh sleep data",
    group: "health-toolbar",
    description: "Reload sleep history, regularity, and baseline",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="health-view-btn health-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh sleep data"
      {...agentProps}
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
    </button>
  );
}

function RangeButton({
  days,
  selected,
  onSelect,
  disabled,
}: {
  days: WindowDays;
  selected: boolean;
  onSelect: (days: WindowDays) => void;
  disabled: boolean;
}): ReactNode {
  const activate = useCallback(() => onSelect(days), [days, onSelect]);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `health-range-${days}`,
    role: "select",
    label: `Show last ${days} days`,
    group: "health-window-range",
    description: `Set the sleep look-back window to ${days} days`,
    onActivate: activate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="health-view-range-btn"
      aria-pressed={selected}
      aria-label={`Show last ${days} days`}
      onClick={activate}
      disabled={disabled}
      {...agentProps}
    >
      {days}d
    </button>
  );
}

function WindowRange({
  windowDays,
  onSelect,
  disabled,
}: {
  windowDays: WindowDays;
  onSelect: (days: WindowDays) => void;
  disabled: boolean;
}): ReactNode {
  return (
    <fieldset
      aria-label="Sleep window range"
      style={{
        display: "flex",
        gap: 6,
        border: "none",
        margin: 0,
        padding: 0,
      }}
    >
      <legend style={visuallyHiddenStyle}>Sleep window range</legend>
      {WINDOW_OPTIONS.map((days) => (
        <RangeButton
          key={days}
          days={days}
          selected={days === windowDays}
          onSelect={onSelect}
          disabled={disabled}
        />
      ))}
    </fieldset>
  );
}

function HealthHeader({
  ownerName,
  windowDays,
  onSelectWindow,
  refetch,
  busy,
}: {
  ownerName: string;
  windowDays: WindowDays;
  onSelectWindow: (days: WindowDays) => void;
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Health</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <WindowRange
            windowDays={windowDays}
            onSelect={onSelectWindow}
            disabled={busy}
          />
          <RefreshButton onActivate={refetch} disabled={busy} />
        </div>
      </div>
      <div style={subtitleStyle}>
        {`Sleep, circadian rhythm, and the rolling baseline for ${ownerName}.`}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (display-only; no business computation).
// ---------------------------------------------------------------------------

function formatDateTime(value: string | null): string {
  if (!value) return "in progress";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

function formatLocalHour(hour: number | null): string {
  if (hour === null) return "—";
  const normalized = ((hour % 24) + 24) % 24;
  const whole = Math.floor(normalized);
  const mins = Math.round((normalized - whole) * 60);
  const stamp = `${String(whole).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  return stamp;
}

const REGULARITY_LABELS: Record<LifeOpsRegularityClass, string> = {
  very_regular: "Very regular",
  regular: "Regular",
  irregular: "Irregular",
  very_irregular: "Very irregular",
  insufficient_data: "Insufficient data",
};

function StatRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div style={statRowStyle}>
      <span style={statLabelStyle}>{label}</span>
      <span style={statValueStyle}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Populated sub-sections.
// ---------------------------------------------------------------------------

function LatestNightCard({
  episode,
}: {
  episode: LifeOpsSleepHistoryEpisode;
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="health-latest-night">
      <h2 style={h2Style}>Last sleep</h2>
      <StatRow label="Duration" value={formatDuration(episode.durationMin)} />
      <StatRow label="Bedtime" value={formatDateTime(episode.startedAt)} />
      <StatRow label="Wake" value={formatDateTime(episode.endedAt)} />
      <StatRow label="Type" value={episode.cycleType} />
      <StatRow label="Source" value={episode.source} />
      <StatRow
        label="Confidence"
        value={`${Math.round(episode.confidence * 100)}%`}
      />
    </div>
  );
}

function RegularityCard({
  regularity,
}: {
  regularity: LifeOpsSleepRegularityResponse;
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="health-regularity">
      <h2 style={h2Style}>Regularity</h2>
      <StatRow
        label="Classification"
        value={REGULARITY_LABELS[regularity.classification]}
      />
      <StatRow label="SRI" value={`${Math.round(regularity.sri)}`} />
      <StatRow
        label="Bedtime spread"
        value={formatDuration(Math.round(regularity.bedtimeStddevMin))}
      />
      <StatRow
        label="Wake spread"
        value={formatDuration(Math.round(regularity.wakeStddevMin))}
      />
      <StatRow label="Samples" value={`${regularity.sampleSize}`} />
    </div>
  );
}

function BaselineCard({
  baseline,
}: {
  baseline: LifeOpsPersonalBaselineResponse;
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="health-baseline">
      <h2 style={h2Style}>Baseline</h2>
      <StatRow
        label="Typical bedtime"
        value={formatLocalHour(baseline.medianBedtimeLocalHour)}
      />
      <StatRow
        label="Typical wake"
        value={formatLocalHour(baseline.medianWakeLocalHour)}
      />
      <StatRow
        label="Typical duration"
        value={formatDuration(baseline.medianSleepDurationMin)}
      />
      <StatRow label="Samples" value={`${baseline.sampleSize}`} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

interface SleepData {
  history: LifeOpsSleepHistoryResponse;
  regularity: LifeOpsSleepRegularityResponse;
  baseline: LifeOpsPersonalBaselineResponse;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SleepData };

export function HealthView(props: HealthViewProps = {}): ReactNode {
  useHealthViewStyles();

  const ownerName = props.ownerName ?? "Owner";
  const fetchers = props.fetchers ?? defaultFetchers;
  const [windowDays, setWindowDays] = useState<WindowDays>(
    props.initialWindowDays ?? 14,
  );
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback((days: WindowDays) => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([
      fetchersRef.current.fetchHistory(days),
      fetchersRef.current.fetchRegularity(days),
      fetchersRef.current.fetchBaseline(days),
    ])
      .then(([history, regularity, baseline]) => {
        if (!cancelled) {
          setState({ kind: "ready", data: { history, regularity, baseline } });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not load sleep data.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(windowDays), [load, windowDays]);

  const refetch = useCallback(() => load(windowDays), [load, windowDays]);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="health-loading">
        <HealthHeader
          ownerName={ownerName}
          windowDays={windowDays}
          onSelectWindow={setWindowDays}
          refetch={refetch}
          busy={true}
        />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading sleep data…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="health-error">
        <HealthHeader
          ownerName={ownerName}
          windowDays={windowDays}
          onSelectWindow={setWindowDays}
          refetch={refetch}
          busy={false}
        />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load sleep data</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="health-view-btn health-view-btn-primary"
              onClick={refetch}
              aria-label="Retry loading sleep data"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { history, regularity, baseline } = state.data;
  const [latest] = history.episodes;

  // No sleep episodes recorded → no linked source yet. Honest connect-a-source
  // affordance; this doubles as the disconnected state.
  if (!latest) {
    return (
      <div style={containerStyle} data-testid="health-empty">
        <HealthHeader
          ownerName={ownerName}
          windowDays={windowDays}
          onSelectWindow={setWindowDays}
          refetch={refetch}
          busy={false}
        />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No sleep data yet</div>
          <div style={dimStyle}>
            Nothing was recorded in the last {history.windowDays} days. Connect
            a health source (Apple Health, Google Fit, Oura, Fitbit, Withings,
            or Strava) so Eliza can track your sleep and circadian rhythm.
          </div>
          <div style={dimStyle}>
            Ask the assistant to “connect a health source” to get started.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="health-populated">
      <HealthHeader
        ownerName={ownerName}
        windowDays={windowDays}
        onSelectWindow={setWindowDays}
        refetch={refetch}
        busy={false}
      />
      <section style={sectionStyle}>
        <div style={gridStyle}>
          <LatestNightCard episode={latest} />
          <RegularityCard regularity={regularity} />
          <BaselineCard baseline={baseline} />
        </div>
      </section>
      <section style={sectionStyle}>
        <div style={{ ...cardStyle }} data-testid="health-window-summary">
          <h2 style={h2Style}>Window summary</h2>
          <StatRow
            label="Nights recorded"
            value={`${history.summary.cycleCount}`}
          />
          <StatRow
            label="Average duration"
            value={formatDuration(history.summary.averageDurationMin)}
          />
          <StatRow
            label="Overnight"
            value={`${history.summary.overnightCount}`}
          />
          <StatRow label="Naps" value={`${history.summary.napCount}`} />
        </div>
      </section>
    </div>
  );
}

export default HealthView;
