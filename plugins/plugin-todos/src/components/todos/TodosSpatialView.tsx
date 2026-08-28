/**
 * TodosSpatialView — the owner three-lane todo board authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI today through `<SpatialSurface>` (DOM).
 *   - Future adapters can reuse the same snapshot contract behind the retained modality types.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * without pulling browser-only runtime imports into the presentational layer.
 *
 * Lanes (Today / Upcoming / Someday) are computed in the data wrapper
 * ({@link ./TodosView.tsx}) and handed in already grouped; this component never
 * fetches or computes — it displays the snapshot and dispatches actions.
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
    <Card gap={1} padding={1} grow={1} shrink={0}>
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <TodosErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <TodosEmptyBody dispatch={dispatch} />
      ) : (
        <TodosReadyBody snapshot={snapshot} dispatch={dispatch} />
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
    <VStack grow={1} justify="center" align="center" gap={1} padding={2}>
      <Text bold align="center">
        No todos yet
      </Text>
      <Text tone="muted" style="caption" align="center">
        Add something you want Eliza to keep track of.
      </Text>
      <HStack gap={1}>
        <Button agent="add" onPress={dispatch("add")}>
          Add todo
        </Button>
      </HStack>
    </VStack>
  );
}

function TodosReadyBody({
  snapshot,
  dispatch,
}: {
  snapshot: TodosSnapshot;
  dispatch: (action: string) => () => void;
}) {
  const total = LANES.reduce(
    (count, lane) => count + snapshot.lanes[lane.id].length,
    0,
  );
  return (
    <>
      <HStack gap={1} align="center">
        <VStack gap={0} grow={1}>
          <Text bold>{`${total} open`}</Text>
          {snapshot.overdue > 0 ? (
            <Text tone="warning" style="caption">
              {snapshot.overdue === 1
                ? "1 overdue"
                : `${snapshot.overdue} overdue`}
            </Text>
          ) : null}
        </VStack>
        <Button agent="add" onPress={dispatch("add")}>
          Add todo
        </Button>
      </HStack>
      {LANES.map((lane, index) => (
        <Lane
          key={lane.id}
          lane={lane}
          todos={snapshot.lanes[lane.id]}
          isLast={index === LANES.length - 1}
        />
      ))}
    </>
  );
}

function Lane({
  lane,
  todos,
  isLast,
}: {
  lane: LaneDef;
  todos: TodoCard[];
  isLast: boolean;
}) {
  return (
    <VStack gap={1} padding={isLast ? undefined : { bottom: 2 }}>
      <HStack gap={1} align="center">
        <Text bold style="caption" wrap={false} shrink={0}>
          {`${lane.label} (${todos.length})`}
        </Text>
        <Divider grow={1} />
      </HStack>
      {todos.length > 0 ? (
        <List gap={0}>
          {todos.map((todo) => (
            <HStack
              key={todo.id}
              gap={2}
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
    </VStack>
  );
}
