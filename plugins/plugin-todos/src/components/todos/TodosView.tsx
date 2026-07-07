/**
 * TodosView — the GUI data wrapper for the owner todo board.
 *
 * It owns the live todos data (the fetcher seam over the single read-only
 * endpoint PA serves, the quiet background poll, wire->display mapping, lane
 * grouping, and the overdue signal) and renders the one presentational
 * {@link TodosSpatialView} inside a {@link SpatialSurface}.
 *
 * Data source (PA owns the shared scheduled-task spine; this plugin only reads):
 *   GET {base}/api/lifeops/todos -> { todos: TodoWire[] }
 *
 * The board is read-only: the only owner actions are `add` (route an add-a-todo
 * request through the assistant chat — no fabricated todos) and `retry` (reload
 * after an error). This plugin MUST NOT import from
 * @elizaos/plugin-personal-assistant; the wire DTO below is declared locally to
 * match the JSON shape PA emits.
 */

import { client } from "@elizaos/ui";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_LANES,
  type LaneId,
  type TodoCard,
  type TodosSnapshot,
  TodosSpatialView,
} from "./TodosSpatialView.tsx";

// ---------------------------------------------------------------------------
// Wire DTO — local mirror of the JSON shape served by the PA todos route.
// Never import PA types here; keep this view's contract self-contained and
// aligned by shape.
// ---------------------------------------------------------------------------

interface TodoWire {
  id: string;
  title: string;
  status: string;
  dueDate: string | null;
}

interface TodosWire {
  todos: TodoWire[];
}

// ---------------------------------------------------------------------------
// Fetcher seam — default to a real GET; tests inject an offline fake.
// ---------------------------------------------------------------------------

export interface TodosFetchers {
  fetchTodos: () => Promise<TodosWire>;
}

async function getTodos(): Promise<TodosWire> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/todos`);
  if (!response.ok) {
    throw new Error(`Todos request failed (${response.status})`);
  }
  return (await response.json()) as TodosWire;
}

const defaultFetchers: TodosFetchers = {
  fetchTodos: getTodos,
};

export interface TodosViewProps {
  /** Test/host injection seam. Defaults to the real `/api/lifeops/todos` GET. */
  fetchers?: TodosFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping.
// ---------------------------------------------------------------------------

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];
const KNOWN_STATUSES: ReadonlySet<string> = new Set(TODO_STATUSES);

/** Coerce an unknown wire status; unknowns settle to "pending". */
function toStatus(value: string): TodoStatus {
  return KNOWN_STATUSES.has(value) ? (value as TodoStatus) : "pending";
}

interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  dueDate: string | null;
}

function mapTodo(wire: TodoWire): TodoItem {
  return {
    id: wire.id,
    title: wire.title,
    status: toStatus(wire.status),
    dueDate: wire.dueDate,
  };
}

// An active todo is one still on the board: pending or in_progress.
function isActive(todo: TodoItem): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function laneFor(todo: TodoItem, now: number): LaneId {
  if (!todo.dueDate) return "someday";
  const ts = Date.parse(todo.dueDate);
  if (Number.isNaN(ts)) return "someday";
  return ts <= now + DAY_MS ? "today" : "upcoming";
}

// Overdue = an active todo whose due date is already in the past. Distinct from
// the Today lane (which also holds items due within the next 24h), so a count of
// these is a non-redundant, actionable proactive signal.
function overdueCount(todos: TodoItem[], now: number): number {
  let count = 0;
  for (const todo of todos) {
    if (!isActive(todo) || !todo.dueDate) continue;
    const ts = Date.parse(todo.dueDate);
    if (!Number.isNaN(ts) && ts < now) count += 1;
  }
  return count;
}

function formatDue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function toCard(todo: TodoItem): TodoCard {
  return {
    id: todo.id,
    title: todo.title,
    inProgress: todo.status === "in_progress",
    due: formatDue(todo.dueDate),
  };
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; todos: TodoItem[] };

function requestNewTodo(): void {
  // The add-a-todo affordance routes through the assistant chat. `client` does
  // not type `sendChatMessage`, so read it through a narrow optional-method view
  // and call it only when present — no fabricated todos, best-effort dispatch.
  const send = (client as { sendChatMessage?: (text: string) => void })
    .sendChatMessage;
  send?.("Add a todo for me.");
}

export function TodosView(props: TodosViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchersRef.current
      .fetchTodos()
      .then((wire) => {
        if (cancelled) return;
        setState({ kind: "ready", todos: wire.todos.map(mapTodo) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not load todos.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Background poll: refresh the board on an interval without flashing the
  // loading state. Transient poll failures are ignored — the explicit Retry
  // path is what surfaces errors to the user.
  useEffect(() => {
    const id = setInterval(() => {
      fetchersRef.current
        .fetchTodos()
        .then((wire) => {
          setState((prev) =>
            prev.kind === "error"
              ? prev
              : { kind: "ready", todos: wire.todos.map(mapTodo) },
          );
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Lane grouping is presentation-only over the active todos the route returns.
  const lanes = useMemo(() => {
    const grouped: Record<LaneId, TodoCard[]> = {
      today: [],
      upcoming: [],
      someday: [],
    };
    if (state.kind !== "ready") return grouped;
    const now = Date.now();
    for (const todo of state.todos) {
      if (!isActive(todo)) continue;
      grouped[laneFor(todo, now)].push(toCard(todo));
    }
    return grouped;
  }, [state]);

  // Proactive signal: how many active todos are already past due.
  const overdue = useMemo(
    () => (state.kind === "ready" ? overdueCount(state.todos, Date.now()) : 0),
    [state],
  );

  const snapshot = useMemo<TodosSnapshot>(() => {
    if (state.kind === "loading") {
      return { state: "loading", lanes: EMPTY_LANES, overdue: 0 };
    }
    if (state.kind === "error") {
      return {
        state: "error",
        lanes: EMPTY_LANES,
        overdue: 0,
        error: state.message,
      };
    }
    const activeCount =
      lanes.today.length + lanes.upcoming.length + lanes.someday.length;
    if (activeCount === 0) {
      return { state: "empty", lanes: EMPTY_LANES, overdue: 0 };
    }
    return { state: "ready", lanes, overdue };
  }, [state, lanes, overdue]);

  const onAction = useCallback(
    (action: string) => {
      switch (action) {
        case "retry":
          load();
          return;
        case "add":
          requestNewTodo();
          return;
      }
    },
    [load],
  );

  return <TodosSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default TodosView;
