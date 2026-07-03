/**
 * LifeOpsLiveTestSpatialView — the HITL "LifeOps Live Test" surface authored
 * once with the spatial vocabulary so it renders on every modality:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — the same tree rendered to terminal lines via the shared IR.
 *
 * It is purely presentational: a {@link LifeOpsLiveTestSnapshot} + an action
 * callback in, spatial primitives out. Every string — readiness copy, connector
 * status, the fire outcome — arrives ALREADY RESOLVED from the data wrapper
 * ({@link ./LifeOpsLiveTestView.tsx}). This component never fetches, polls, or
 * computes; it displays the snapshot and dispatches action ids.
 *
 * Brand rules are enforced by the primitives' `tone=` (no raw colors, no blue):
 * a good/ready state is `primary`, a soft "skipped / deferred / needs setup"
 * signal is `warning`, a hard failure is `danger`, and neutral labels are
 * `muted`.
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  Text,
  VStack,
} from "@elizaos/ui/spatial";

/** Whether the agent has a working model wired (drives the first checklist row). */
export type ModelReadiness = "ready" | "not-ready" | "unknown";

/** A tone-carrying outcome line, already resolved to display strings. */
export interface OutcomeCard {
  /** Semantic tone: success → primary, soft signal → warning, failure → danger. */
  tone: "primary" | "warning" | "danger";
  /** Short headline (e.g. "Fired", "Skipped", "Dispatch failed"). */
  title: string;
  /** One plain-language sentence describing what happened. */
  detail: string;
}

/** A readiness checklist row (model or a connector). */
export interface ChecklistRow {
  /** Stable id used for the connect action (`plugin.id` for connectors). */
  id: string;
  /** Display label (e.g. "AI model", "Google"). */
  label: string;
  /** Secondary status line (e.g. "Connected", "Not connected"). */
  status: string;
  /** True when the row is satisfied (drives the ✓/✗ glyph + tone). */
  ready: boolean;
  /** Tri-state for the glyph: unknown renders a neutral dot, not a ✗. */
  pending?: boolean;
  /** Label for the connect action button, or empty to hide it. */
  action: string;
}

/** The run-panel state machine. */
export type RunState = "idle" | "running" | "done";

/** One scheduled-task row in the "Recent scheduled tasks" list. */
export interface TaskRowCard {
  id: string;
  /** Pre-formatted primary line — the task's prompt instructions. */
  title: string;
  /** Pre-formatted secondary line (kind • status). */
  meta: string;
  /** True while a fire-now request for this row is in flight. */
  firing: boolean;
  /** The last fire outcome for this row, or undefined before any fire. */
  fire?: OutcomeCard;
}

export type TasksState = "loading" | "error" | "ready";

export interface LifeOpsLiveTestSnapshot {
  /** The AI-model readiness row (the #1 blocker for a live run). */
  model: ChecklistRow;
  /** The key LifeOps connectors present, in a stable order. */
  connectors: ChecklistRow[];
  /** The run panel: pending state + the last validation outcome. */
  run: {
    state: RunState;
    kind?: "reminder" | "checkin";
    outcome?: OutcomeCard;
  };
  /** The recent scheduled tasks list. */
  tasks: { state: TasksState; error?: string; rows: TaskRowCard[] };
}

export const EMPTY_LIFEOPS_LIVE_TEST_SNAPSHOT: LifeOpsLiveTestSnapshot = {
  model: {
    id: "model",
    label: "AI model",
    status: "Checking…",
    ready: false,
    pending: true,
    action: "Connect a model",
  },
  connectors: [],
  run: { state: "idle" },
  tasks: { state: "loading", rows: [] },
};

export interface LifeOpsLiveTestSpatialViewProps {
  snapshot: LifeOpsLiveTestSnapshot;
  /**
   * Dispatch by agent id:
   *   `connect-model`             open Settings → AI model,
   *   `connect-connector:<id>`    open Settings → Connectors focused on <id>,
   *   `run-reminder`              seed + fire a due-now reminder,
   *   `run-checkin`               seed + fire a due-now check-in,
   *   `fire:<taskId>`             fire an existing task on demand,
   *   `retry`                     reload the scheduled-task list.
   */
  onAction?: (action: string) => void;
}

/** ✓ when ready, • while pending/unknown, ✗ otherwise. */
function StatusGlyph({ row }: { row: ChecklistRow }) {
  const glyph = row.ready ? "✓" : row.pending ? "•" : "✗";
  const tone = row.ready ? "primary" : row.pending ? "muted" : "warning";
  return (
    <Text bold tone={tone} wrap={false}>
      {glyph}
    </Text>
  );
}

function ChecklistRowView({
  row,
  dispatch,
}: {
  row: ChecklistRow;
  dispatch: (action: string) => () => void;
}) {
  return (
    <HStack gap={1} align="center" width="100%">
      <StatusGlyph row={row} />
      <VStack gap={0} grow={1}>
        <Text bold wrap={false}>
          {row.label}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {row.status}
        </Text>
      </VStack>
      {!row.ready && row.action ? (
        <Button
          variant="outline"
          agent={`connect-${row.id}`}
          onPress={dispatch(
            row.id === "model"
              ? "connect-model"
              : `connect-connector:${row.id}`,
          )}
        >
          {row.action}
        </Button>
      ) : null}
    </HStack>
  );
}

function OutcomeCardView({ outcome }: { outcome: OutcomeCard }) {
  return (
    <Card gap={0} padding={1} border="round" tone={outcome.tone}>
      <Text bold tone={outcome.tone} wrap={false}>
        {outcome.title}
      </Text>
      <Text style="caption" tone={outcome.tone}>
        {outcome.detail}
      </Text>
    </Card>
  );
}

function RunPanel({
  run,
  dispatch,
}: {
  run: LifeOpsLiveTestSnapshot["run"];
  dispatch: (action: string) => () => void;
}) {
  const running = run.state === "running";
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        Run a validation
      </Text>
      <HStack gap={1} wrap>
        <Button
          tone="primary"
          disabled={running}
          agent="run-reminder"
          onPress={dispatch("run-reminder")}
        >
          Run live validation
        </Button>
        <Button
          variant="outline"
          disabled={running}
          agent="run-checkin"
          onPress={dispatch("run-checkin")}
        >
          Run check-in probe
        </Button>
      </HStack>
      {running ? (
        <Text style="caption" tone="muted">
          Seeding a due-now task and firing it…
        </Text>
      ) : run.outcome ? (
        <OutcomeCardView outcome={run.outcome} />
      ) : (
        <Text style="caption" tone="muted">
          Seeds a real due-now task and fires it through the scheduler — watch
          the outcome below.
        </Text>
      )}
    </VStack>
  );
}

function TaskRowView({
  row,
  dispatch,
}: {
  row: TaskRowCard;
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={0} width="100%">
      <HStack gap={1} align="center" width="100%">
        <VStack gap={0} grow={1}>
          <Text bold wrap={false}>
            {row.title}
          </Text>
          <Text style="caption" tone="muted" wrap={false}>
            {row.meta}
          </Text>
        </VStack>
        <Button
          variant="outline"
          disabled={row.firing}
          agent={`fire-${row.id}`}
          onPress={dispatch(`fire:${row.id}`)}
        >
          {row.firing ? "Firing…" : "Fire now"}
        </Button>
      </HStack>
      {row.fire ? (
        <Text style="caption" tone={row.fire.tone} wrap={false}>
          {row.fire.title} — {row.fire.detail}
        </Text>
      ) : null}
    </VStack>
  );
}

function TasksSection({
  tasks,
  dispatch,
}: {
  tasks: LifeOpsLiveTestSnapshot["tasks"];
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={1} width="100%">
      <Text style="caption" tone="muted">
        Recent scheduled tasks ({tasks.rows.length})
      </Text>
      {tasks.state === "loading" ? (
        <Text style="caption" tone="muted">
          Loading
        </Text>
      ) : tasks.state === "error" ? (
        <>
          <Text style="caption" tone="danger">
            {tasks.error ?? "Could not load scheduled tasks."}
          </Text>
          <HStack gap={1}>
            <Button variant="outline" agent="retry" onPress={dispatch("retry")}>
              Retry
            </Button>
          </HStack>
        </>
      ) : tasks.rows.length === 0 ? (
        <Text style="caption" tone="muted">
          No scheduled tasks yet — run a validation above to create one.
        </Text>
      ) : (
        <List gap={1}>
          {tasks.rows.map((row) => (
            <TaskRowView key={row.id} row={row} dispatch={dispatch} />
          ))}
        </List>
      )}
    </VStack>
  );
}

export function LifeOpsLiveTestSpatialView({
  snapshot,
  onAction,
}: LifeOpsLiveTestSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1}>
      <VStack gap={0}>
        <Text style="heading" bold>
          LifeOps Live Test
        </Text>
        <Text style="caption" tone="muted">
          Connect your model and accounts, then run a real LifeOps validation
          and watch it fire.
        </Text>
      </VStack>

      <Divider label="Readiness" />
      <ChecklistRowView row={snapshot.model} dispatch={dispatch} />
      {snapshot.connectors.length === 0 ? (
        <Text style="caption" tone="muted">
          No connectors detected.
        </Text>
      ) : (
        <List gap={1}>
          {snapshot.connectors.map((row) => (
            <ChecklistRowView key={row.id} row={row} dispatch={dispatch} />
          ))}
        </List>
      )}

      <Divider label="Run" />
      <RunPanel run={snapshot.run} dispatch={dispatch} />

      <Divider label="Scheduled tasks" />
      <TasksSection tasks={snapshot.tasks} dispatch={dispatch} />
    </Card>
  );
}

export default LifeOpsLiveTestSpatialView;
