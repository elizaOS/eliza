/**
 * HealthSpatialView — the owner sleep summary authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no browser/client import).
 *
 * The numeric sleep summary (last-night, regularity, baseline, window summary)
 * is computed/formatted in the data wrapper ({@link ./HealthView.tsx}) and
 * handed in already projected to display strings; this component never fetches
 * or computes — it displays label/value rows and dispatches actions.
 */

import { Button, Card, Escape, HStack, List, Text } from "@elizaos/ui/spatial";
import type { CSSProperties } from "react";

/** A single label/value summary row, already projected to display strings. */
export interface StatRow {
  label: string;
  value: string;
}

/** The selectable look-back window in days. */
export type WindowDays = 7 | 14 | 30;

/** Which render state the view is in. */
export type HealthViewState = "loading" | "error" | "empty" | "ready";

export interface HealthSnapshot {
  /** The view state machine. */
  state: HealthViewState;
  /** Active look-back window; drives the range control's selected tone. */
  windowDays: WindowDays;
  /** Quiet proactive line when regularity reads off-rhythm; empty otherwise. */
  proactive: string;
  /** Last-sleep rows (only meaningful when state === "ready"). */
  lastSleep: StatRow[];
  /** Regularity rows (only meaningful when state === "ready"). */
  regularity: StatRow[];
  /** Baseline rows (only meaningful when state === "ready"). */
  baseline: StatRow[];
  /** Window-summary rows (only meaningful when state === "ready"). */
  windowSummary: StatRow[];
  /** Pre-formatted "no data recorded in the last N days" body for empty state. */
  emptyDetail: string;
  /** Error message when state === "error". */
  error?: string;
}

const WINDOW_OPTIONS: readonly WindowDays[] = [7, 14, 30];

export const EMPTY_HEALTH_SNAPSHOT: HealthSnapshot = {
  state: "loading",
  windowDays: 14,
  proactive: "",
  lastSleep: [],
  regularity: [],
  baseline: [],
  windowSummary: [],
  emptyDetail: "",
};

export interface HealthSpatialViewProps {
  snapshot: HealthSnapshot;
  /**
   * Dispatch by agent id: `retry` (reload after an error),
   * `window:7` | `window:14` | `window:30` (set the look-back window).
   */
  onAction?: (action: string) => void;
}

export function HealthSpatialView({
  snapshot,
  onAction,
}: HealthSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1} grow={1}>
      <WindowRange windowDays={snapshot.windowDays} dispatch={dispatch} />

      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <HealthErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <HealthEmptyBody />
      ) : (
        <HealthReadyBody snapshot={snapshot} />
      )}
    </Card>
  );
}

function WindowRange({
  windowDays,
  dispatch,
}: {
  windowDays: WindowDays;
  dispatch: (action: string) => () => void;
}) {
  return (
    <HStack gap={1} align="center" padding={{ left: 12 }}>
      {WINDOW_OPTIONS.map((days) => {
        const selected = days === windowDays;
        return (
          <Button
            key={days}
            agent={`window-${days}`}
            tone={selected ? "primary" : "default"}
            variant={selected ? "solid" : "outline"}
            onPress={dispatch(`window:${days}`)}
          >
            {`${days}d`}
          </Button>
        );
      })}
    </HStack>
  );
}

function HealthErrorBody({
  snapshot,
  dispatch,
}: {
  snapshot: HealthSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Could not load sleep data</Text>
      <Text tone="danger" style="caption">
        {snapshot.error ?? "Could not load sleep data."}
      </Text>
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function HealthEmptyBody() {
  return <Text bold>None</Text>;
}

function HealthReadyBody({ snapshot }: { snapshot: HealthSnapshot }) {
  return (
    <Escape grow={1} tui={<SpatialReadyBody snapshot={snapshot} />}>
      <div style={readyShellStyle}>
        {snapshot.proactive ? (
          <p style={proactiveLineStyle}>{snapshot.proactive}</p>
        ) : null}
        <div style={readyGridStyle}>
          <DomSection label="Last sleep" rows={snapshot.lastSleep} />
          <DomSection label="Regularity" rows={snapshot.regularity} />
          <DomSection label="Baseline" rows={snapshot.baseline} />
          <DomSection label="Window summary" rows={snapshot.windowSummary} />
        </div>
      </div>
    </Escape>
  );
}

function SpatialReadyBody({ snapshot }: { snapshot: HealthSnapshot }) {
  return (
    <>
      {snapshot.proactive ? (
        <Text tone="warning" style="caption">
          {snapshot.proactive}
        </Text>
      ) : null}
      <Section label="Last sleep" rows={snapshot.lastSleep} />
      <Section label="Regularity" rows={snapshot.regularity} />
      <Section label="Baseline" rows={snapshot.baseline} />
      <Section label="Window summary" rows={snapshot.windowSummary} />
    </>
  );
}

const readyShellStyle: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: "0.5rem",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
  overflowX: "hidden",
  overflowY: "auto",
  padding: "0.125rem 0.125rem 4.5rem",
};

const proactiveLineStyle: CSSProperties = {
  color: "var(--warning, #c98a00)",
  fontSize: "0.85rem",
  lineHeight: 1.35,
  margin: 0,
};

const readyGridStyle: CSSProperties = {
  alignItems: "start",
  display: "grid",
  gap: "0.5rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(12rem, 100%), 1fr))",
  minWidth: 0,
};

const domSectionStyle: CSSProperties = {
  boxSizing: "border-box",
  minWidth: 0,
  padding: "0.25rem 0.125rem",
};

const domSectionTitleStyle: CSSProperties = {
  color: "var(--muted-foreground, #777)",
  fontSize: "0.72rem",
  fontWeight: 600,
  lineHeight: 1.15,
  margin: "0 0 0.25rem",
};

const definitionListStyle: CSSProperties = {
  display: "grid",
  gap: "0.16rem",
  margin: 0,
  minWidth: 0,
};

const domRowStyle: CSSProperties = {
  alignItems: "baseline",
  display: "grid",
  gap: "0.45rem",
  gridTemplateColumns: "minmax(0, 1fr) minmax(4rem, auto)",
  minWidth: 0,
};

const domLabelStyle: CSSProperties = {
  color: "var(--muted-foreground, #777)",
  fontSize: "0.82rem",
  lineHeight: 1.15,
  margin: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const domValueStyle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 600,
  lineHeight: 1.15,
  margin: 0,
  maxWidth: "14rem",
  minWidth: 0,
  overflow: "hidden",
  textAlign: "right",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function DomSection({ label, rows }: { label: string; rows: StatRow[] }) {
  if (rows.length === 0) return null;

  return (
    <section style={domSectionStyle} aria-label={label}>
      <h2 style={domSectionTitleStyle}>{label}</h2>
      <dl style={definitionListStyle}>
        {rows.map((row) => (
          <div
            key={row.label}
            data-agent-id={`row-${row.label}`}
            style={domRowStyle}
          >
            <dt style={domLabelStyle}>{row.label}</dt>
            <dd style={domValueStyle} title={row.value}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Section({ label, rows }: { label: string; rows: StatRow[] }) {
  if (rows.length === 0) return null;

  return (
    <>
      <Text style="caption" tone="muted">
        {label}
      </Text>
      <List gap={0}>
        {rows.map((row) => (
          <HStack
            key={row.label}
            gap={1}
            align="center"
            agent={`row-${row.label}`}
          >
            <Text tone="muted" grow={1}>
              {row.label}
            </Text>
            <Text bold wrap={false}>
              {row.value}
            </Text>
          </HStack>
        ))}
      </List>
    </>
  );
}
