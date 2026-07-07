/**
 * TodosSpatialView — the owner three-lane todo board authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI — mounted in `<SpatialSurface>` (DOM). Only the GUI modality ships;
 *     "xr" and "tui" remain compatibility values in the manifest schema.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no browser/client import).
 *
 * Lanes (Today / Upcoming / Someday) are computed in the data wrapper
 * ({@link ./TodosView.tsx}) and handed in already grouped; this component never
 * fetches or computes — it displays the snapshot and dispatches actions.
 */

import { Button, Card, HStack, List, Text, VStack } from "@elizaos/ui/spatial";

export type LaneId = "today" | "upcoming" | "someday";

/** A single board item, already projected to display shape by the wrapper. */
export interface TodoCard {
  id: string;
  title: string;
  /** "in_progress" runs the busy dot; "pending" is idle. */
  inProgress: boolean;
  /** Pre-formatted due label (e.g. "Jun 24"), or empty when none. */
  due: string;
}

/** Which render state the board is in. */
export type TodosViewState = "loading" | "error" | "empty" | "ready";

interface LaneDef {
  id: LaneId;
  label: string;
}

const LANES: readonly LaneDef[] = [
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "someday", label: "Someday" },
];

export interface TodosSnapshot {
  /** The board state machine. */
  state: TodosViewState;
  /** Active todos grouped by lane (only meaningful when state === "ready"). */
  lanes: Record<LaneId, TodoCard[]>;
  /** Count of active todos already past due (proactive signal). */
  overdue: number;
  /** Error message when state === "error". */
  error?: string;
}

export const EMPTY_LANES: Record<LaneId, TodoCard[]> = {
  today: [],
  upcoming: [],
  someday: [],
};

export interface TodosSpatialViewProps {
  snapshot: TodosSnapshot;
  /** Dispatch by agent id: `add` (route to chat), `retry` (reload). */
  onAction?: (action: string) => void;
}

export function TodosSpatialView({
  snapshot,
  onAction,
}: TodosSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1}>
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <TodosErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <TodosEmptyBody dispatch={dispatch} />
      ) : (
        <TodosReadyBody snapshot={snapshot} />
      )}
    </Card>
  );
}

function TodosErrorBody({
  snapshot,
  dispatch,
}: {
  snapshot: TodosSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Could not load todos</Text>
      <Text tone="danger" style="caption">
        {snapshot.error ?? "Could not load todos."}
      </Text>
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function TodosEmptyBody({
  dispatch,
}: {
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>None</Text>
      <HStack gap={1}>
        <Button agent="add" onPress={dispatch("add")}>
          Add
        </Button>
      </HStack>
    </>
  );
}

function TodosReadyBody({ snapshot }: { snapshot: TodosSnapshot }) {
  return (
    <>
      {snapshot.overdue > 0 ? (
        <Text tone="warning" style="caption">
          {snapshot.overdue === 1
            ? "1 todo is overdue."
            : `${snapshot.overdue} todos are overdue.`}
        </Text>
      ) : null}
      {LANES.map((lane) => (
        <Lane key={lane.id} lane={lane} todos={snapshot.lanes[lane.id]} />
      ))}
    </>
  );
}

function Lane({ lane, todos }: { lane: LaneDef; todos: TodoCard[] }) {
  return (
    <>
      <Text style="caption" tone="muted">
        {lane.label} ({todos.length})
      </Text>
      {todos.length > 0 ? (
        <List gap={0}>
          {todos.map((todo) => (
            <HStack
              key={todo.id}
              gap={1}
              align="center"
              agent={`todo-${todo.id}`}
            >
              <Text tone={todo.inProgress ? "primary" : "muted"} wrap={false}>
                {todo.inProgress ? "●" : "○"}
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {todo.title}
                </Text>
              </VStack>
              {todo.due ? (
                <Text style="caption" tone="muted" wrap={false}>
                  {todo.due}
                </Text>
              ) : null}
            </HStack>
          ))}
        </List>
      ) : null}
    </>
  );
}
