/**
 * TodosView — owner three-lane todo board.
 *
 * Data-fetching view over the single read-only todos endpoint served by the
 * personal-assistant routes (PA owns the shared scheduled-task spine; this
 * plugin only renders):
 *   GET {base}/api/lifeops/todos
 *
 * The wire payload is `{ todos: TodoWire[] }`, projected by PA from the owner's
 * `life_task_*` occurrences. We map each wire row to a `TodoItem` at the fetch
 * boundary so the rest of the view renders display-only.
 *
 * Lanes (computed from the real `dueDate` field):
 *  - Today    — active todos due now or overdue (dueDate <= now + 24h).
 *  - Upcoming — active todos with a future due date.
 *  - Someday  — active todos with no (or unparseable) due date.
 *
 * It renders one of four distinct states (loading, error, empty, populated) and
 * instruments its refresh control through the agent surface so the floating chat
 * can drive it. The default fetcher builds its URL from `client.getBaseUrl()`;
 * tests inject the fetcher seam so they stay offline.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTO below is declared locally to match the JSON shape PA emits.
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const STATUS_LABELS: Record<TodoStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
};

// An active todo is one still on the board: pending or in_progress.
function isActive(todo: TodoItem): boolean {
  return todo.status === "pending" || todo.status === "in_progress";
}

type LaneId = "today" | "upcoming" | "someday";

const DAY_MS = 24 * 60 * 60 * 1000;

function laneFor(todo: TodoItem, now: number): LaneId {
  if (!todo.dueDate) return "someday";
  const ts = Date.parse(todo.dueDate);
  if (Number.isNaN(ts)) return "someday";
  return ts <= now + DAY_MS ? "today" : "upcoming";
}

interface LaneDef {
  id: LaneId;
  label: string;
  description: string;
}

const LANES: readonly LaneDef[] = [
  { id: "today", label: "Today", description: "Due now or overdue." },
  { id: "upcoming", label: "Upcoming", description: "Scheduled for later." },
  { id: "someday", label: "Someday", description: "No due date yet." },
];

function formatDue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Styling — dark theme, CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "todos-view-styles";

const TODOS_VIEW_CSS = `
.todos-view-btn {
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
.todos-view-btn-primary {
  background: var(--primary, #ff6a00);
  color: var(--primary-foreground, #0a0a0a);
  border: 1px solid var(--primary, #ff6a00);
}
.todos-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff6a00) 82%, black);
}
.todos-view-btn-neutral {
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--foreground, #f5f5f5);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
}
.todos-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #f5f5f5) 8%, transparent);
}
.todos-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;

function useTodosViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = TODOS_VIEW_CSS;
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

const lanesGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
  flex: 1,
  minHeight: 0,
};

const laneCardStyle: CSSProperties = {
  ...cardStyle,
  minHeight: 0,
};

const laneHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
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

const metaStyle: CSSProperties = {
  ...dimStyle,
  whiteSpace: "nowrap",
  flexShrink: 0,
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
    id: "todos-refresh",
    role: "button",
    label: "Refresh todos",
    group: "todos-toolbar",
    description: "Reload the owner's todos across the Today, Upcoming, and Someday lanes",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="todos-view-btn todos-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh todos"
      {...agentProps}
    >
      <RefreshCw className="h-4 w-4" aria-hidden />
    </button>
  );
}

function TodosHeader({
  refetch,
  busy,
}: {
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Todos</h1>
        <RefreshButton onActivate={refetch} disabled={busy} />
      </div>
      <div style={subtitleStyle}>
        Three lanes: Today, Upcoming, Someday.
      </div>
    </header>
  );
}

function TodoRow({ todo }: { todo: TodoItem }): ReactNode {
  const meta: string[] = [STATUS_LABELS[todo.status]];
  if (todo.dueDate) {
    const formatted = formatDue(todo.dueDate);
    if (formatted) meta.push(`due ${formatted}`);
  }
  return (
    <li style={rowStyle}>
      <span style={rowMainStyle}>
        <span style={titleStyle}>{todo.title}</span>
      </span>
      <span style={metaStyle}>{meta.join(" · ")}</span>
    </li>
  );
}

function Lane({ lane, todos }: { lane: LaneDef; todos: TodoItem[] }): ReactNode {
  return (
    <article
      style={laneCardStyle}
      aria-label={`${lane.label} lane`}
      data-testid={`todos-lane-${lane.id}`}
    >
      <div style={laneHeaderStyle}>
        <h2 style={h2Style}>{lane.label}</h2>
        <span style={dimStyle} aria-label={`${lane.label} count`}>
          {todos.length}
        </span>
      </div>
      <div style={dimStyle}>{lane.description}</div>
      {todos.length === 0 ? (
        <div style={{ ...dimStyle, fontStyle: "italic" }}>Nothing here.</div>
      ) : (
        <ul style={listStyle} aria-label={`${lane.label} todos`}>
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} />
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; todos: TodoItem[] };

function requestNewTodo(): void {
  client.sendChatMessage?.("Add a todo for me.");
}

export function TodosView(props: TodosViewProps = {}): ReactNode {
  useTodosViewStyles();

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

  // Lane grouping is presentation-only over the active todos the route returns.
  const byLane = useMemo(() => {
    const grouped: Record<LaneId, TodoItem[]> = {
      today: [],
      upcoming: [],
      someday: [],
    };
    if (state.kind !== "ready") return grouped;
    const now = Date.now();
    for (const todo of state.todos) {
      if (!isActive(todo)) continue;
      grouped[laneFor(todo, now)].push(todo);
    }
    return grouped;
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="todos-loading">
        <TodosHeader refetch={load} busy={true} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading todos…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="todos-error">
        <TodosHeader refetch={load} busy={false} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load todos</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="todos-view-btn todos-view-btn-primary"
              onClick={load}
              aria-label="Retry loading todos"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Fetched OK but no active todos → honest add-a-todo affordance routed through
  // the assistant chat. No fabricated todos.
  const activeCount =
    byLane.today.length + byLane.upcoming.length + byLane.someday.length;
  if (activeCount === 0) {
    return (
      <div style={containerStyle} data-testid="todos-empty">
        <TodosHeader refetch={load} busy={false} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No todos</div>
          <div style={dimStyle}>
            Nothing on the board yet. Ask Eliza to add one — tell her what you
            need to get done and she’ll track it for you.
          </div>
          <div>
            <button
              type="button"
              className="todos-view-btn todos-view-btn-primary"
              onClick={requestNewTodo}
              aria-label="Ask Eliza to add a todo"
            >
              Add a todo
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="todos-populated">
      <TodosHeader refetch={load} busy={false} />
      <section style={lanesGridStyle} aria-label="Todo lanes">
        {LANES.map((lane) => (
          <Lane key={lane.id} lane={lane} todos={byLane[lane.id]} />
        ))}
      </section>
    </div>
  );
}

export default TodosView;
