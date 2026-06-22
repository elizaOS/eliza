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

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  Text,
} from "@elizaos/ui/spatial";

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
    <Card title="Health" gap={1} padding={1}>
      <Text style="caption" tone="muted">
        Sleep, circadian rhythm, and the rolling baseline.
      </Text>

      <WindowRange windowDays={snapshot.windowDays} dispatch={dispatch} />

      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading sleep data
        </Text>
      ) : snapshot.state === "error" ? (
        <HealthErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <HealthEmptyBody snapshot={snapshot} />
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
    <HStack gap={1} align="center">
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
      <Divider label="error" />
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

function HealthEmptyBody({ snapshot }: { snapshot: HealthSnapshot }) {
  return (
    <>
      <Divider label="empty" />
      <Text bold>No sleep data yet</Text>
      <Text tone="muted" style="caption">
        {snapshot.emptyDetail}
      </Text>
      <Text tone="muted" style="caption">
        Ask Eliza to connect a health source to get started.
      </Text>
    </>
  );
}

function HealthReadyBody({ snapshot }: { snapshot: HealthSnapshot }) {
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

function Section({ label, rows }: { label: string; rows: StatRow[] }) {
  return (
    <>
      <Divider label={label} />
      {rows.length === 0 ? (
        <Text tone="muted" style="caption">
          Nothing here.
        </Text>
      ) : (
        <List gap={0}>
          {rows.map((row) => (
            <HStack key={row.label} gap={1} align="center" agent={`row-${row.label}`}>
              <Text tone="muted" grow={1}>
                {row.label}
              </Text>
              <Text bold wrap={false}>
                {row.value}
              </Text>
            </HStack>
          ))}
        </List>
      )}
    </>
  );
}
