/**
 * HealthSpatialView — the owner sleep summary authored once with the spatial
 * vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI today through `<SpatialSurface>` (DOM).
 *   - Future adapters can reuse the same snapshot contract behind the retained modality types.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * without pulling browser-only runtime imports into the presentational layer.
 *
 * The numeric sleep summary (last-night, regularity, baseline, window summary)
 * is computed/formatted in the data wrapper ({@link ./HealthView.tsx}) and
 * handed in already projected to display strings; this component never fetches
 * or computes — it displays label/value rows and dispatches actions.
 */

import {
  Button,
  Card,
  Escape,
  Field,
  HStack,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
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
    <Card gap={1} padding={1} grow={1} shrink={0}>
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
    <Field
      kind="select"
      label="Range"
      value={`Last ${windowDays} days`}
      options={WINDOW_OPTIONS.map((days) => `Last ${days} days`)}
      agent="health-range-filter"
      onChange={(label) => {
        const selected = WINDOW_OPTIONS.find(
          (days) => `Last ${days} days` === label,
        );
        if (selected) dispatch(`window:${selected}`)();
      }}
    />
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
  return (
    <VStack grow={1} justify="center" align="center" gap={1} padding={2}>
      <Text bold align="center">
        No sleep data yet
      </Text>
      <Text tone="muted" style="caption" align="center">
        Connect a health source or record sleep to see patterns here.
      </Text>
    </VStack>
  );
}

function HealthReadyBody({ snapshot }: { snapshot: HealthSnapshot }) {
  return (
    <Escape grow={1}>
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
  columnGap: "2rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(20rem, 100%), 1fr))",
  minWidth: 0,
  rowGap: "1.25rem",
};

const domSectionStyle: CSSProperties = {
  borderTop: "1px solid var(--border, rgba(255, 255, 255, 0.12))",
  boxSizing: "border-box",
  minWidth: 0,
  padding: "0.75rem 0 0",
};

const domSectionTitleStyle: CSSProperties = {
  color: "var(--muted-foreground, #777)",
  fontSize: "0.72rem",
  fontWeight: 600,
  lineHeight: 1.15,
  margin: "0 0 0.625rem",
};

const definitionListStyle: CSSProperties = {
  display: "grid",
  gap: "0.4rem",
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
