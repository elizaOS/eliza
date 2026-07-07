/**
 * The `todo.items` widget, which serves two different surfaces from one
 * registration because the widget host renders it in both:
 *
 *  - Chat sidebar (`TodoSidebarWidget`): the agent's own workbench checklist,
 *    seeded from the app store's `workbench.todos`, refreshed on live workbench
 *    events and a visible-tab repair poll. This is "what the agent is working
 *    on" and is the store's to own.
 *  - Home grid (`TodayHomeCard`): the OWNER's "Today" resident (spec §B.3) —
 *    their due/overdue todos, which carry a `dueDate` the workbench checklist
 *    does not. These are a different domain read entirely, so the home card does
 *    NOT read a store: it renders the typed DTO from the `today-todos-data` read
 *    model (`GET /api/lifeops/todos`) and completes a row through that model's
 *    occurrence-complete write. Per §E item 5 it also absorbs the single most
 *    urgent goal as one flagged row and self-publishes the escalation weight so
 *    the merged card floats up on goal urgency.
 *
 * Exports `TODO_PLUGIN_WIDGETS`, the widget-registry entry the host consumes.
 */
import { Circle, ListTodo, Target } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import type { WorkbenchTodo } from "../../../api/client-types-config";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useAppSelectorShallow } from "../../../state";
import type { TranslateFn } from "../../../types";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import { Badge } from "../../ui/badge";
import {
  type AttentionGoal,
  GOALS_REFRESH_INTERVAL_MS,
  goalsEqual,
  loadGoalsForGlance,
  mostUrgentGoal,
} from "./goals-attention-data";
import { useWidgetNavigation } from "./home-widget-card";
import { EmptyWidgetState, WidgetSection } from "./shared";
import {
  completeTodayTodo,
  dueOrOverdueToday,
  isOverdue,
  loadTodayTodosForGlance,
  TODAY_TODOS_REFRESH_INTERVAL_MS,
  type TodayTodo,
  todosEqual,
} from "./today-todos-data";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

const TODO_WIDGET_KEY = "todo/todo.items";

const TODO_REFRESH_INTERVAL_MS = 15_000;
const MAX_VISIBLE_TODOS = 8;
/** The Today glance shows at most three rows (spec §B.3). */
const MAX_TODAY_ROWS = 3;

const fallbackTranslate: TranslateFn = (key, vars) =>
  typeof vars?.defaultValue === "string" ? vars.defaultValue : key;

function sortTodosForWidget(todos: WorkbenchTodo[]): WorkbenchTodo[] {
  return [...todos].sort((left, right) => {
    if (left.isCompleted !== right.isCompleted) {
      return left.isCompleted ? 1 : -1;
    }
    if (left.isUrgent !== right.isUrgent) {
      return left.isUrgent ? -1 : 1;
    }
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.name.localeCompare(right.name);
  });
}

function dedupeTodos(todos: WorkbenchTodo[]): WorkbenchTodo[] {
  const byId = new Map<string, WorkbenchTodo>();
  for (const todo of todos) {
    byId.set(todo.id, todo);
  }
  return sortTodosForWidget([...byId.values()]);
}

function isWorkbenchTodoChangeEvent(
  event: ChatSidebarWidgetProps["events"][number],
): boolean {
  const source = event.source;
  if (source?.type !== "agent_event" || source.stream !== "workbench") {
    return false;
  }
  const data = source.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "workbench.todo.changed"
  );
}

function homeBadgeClassName(tone: "default" | "home", accent?: string): string {
  if (tone !== "home") return accent ? `text-3xs ${accent}` : "text-3xs";
  return accent
    ? `border-white/15 bg-white/12 text-3xs ${accent}`
    : "border-white/15 bg-white/12 text-3xs text-white/80";
}

function TodoRow({
  todo,
  tone = "default",
}: {
  todo: WorkbenchTodo;
  tone?: "default" | "home";
}) {
  const showDescription =
    todo.description.trim().length > 0 && todo.description !== todo.name;
  const showType = todo.type.trim().length > 0 && todo.type !== "task";
  const isHome = tone === "home";

  return (
    <div
      className={`rounded-sm border p-3 ${
        isHome
          ? "border-white/15 bg-white/10 text-white"
          : "border-border/50 bg-bg/70"
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
            isHome
              ? "bg-white/70"
              : todo.isUrgent
                ? "bg-danger"
                : todo.priority != null
                  ? "bg-accent"
                  : "bg-muted"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`min-w-0 truncate text-xs font-semibold ${
                isHome ? "text-white" : "text-txt"
              }`}
            >
              {todo.name}
            </span>
            {todo.isUrgent ? (
              <Badge
                variant="secondary"
                className={homeBadgeClassName(tone, "text-danger")}
              >
                Urgent
              </Badge>
            ) : null}
            {todo.priority != null ? (
              <Badge variant="secondary" className={homeBadgeClassName(tone)}>
                P{todo.priority}
              </Badge>
            ) : null}
            {showType ? (
              <Badge variant="secondary" className={homeBadgeClassName(tone)}>
                {todo.type}
              </Badge>
            ) : null}
          </div>
          {showDescription ? (
            <p
              className={`mt-1 line-clamp-2 text-xs-tight leading-5 ${
                isHome ? "text-white/70" : "text-muted"
              }`}
            >
              {todo.description}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A single owner-todo row in the Today card. The whole row is the completion
 * affordance (a 44px tap target holds the home hit-area rule): tapping toggles
 * the todo done. Overdue todos carry the accent (spec §B.3 "overdue in the
 * accent color"); an on-time due-today todo is neutral white-family.
 */
function TodayTodoRow({
  todo,
  now,
  onComplete,
}: {
  todo: TodayTodo;
  now: number;
  onComplete: () => void;
}) {
  const overdue = isOverdue(todo, now);
  return (
    <button
      type="button"
      data-testid="today-todo-row"
      aria-label={`Complete todo "${todo.title}"`}
      onClick={onComplete}
      className="flex min-h-11 w-full items-start gap-2 rounded-sm border border-white/15 p-3 text-left text-white"
    >
      <Circle
        className={`mt-0.5 h-4 w-4 shrink-0 ${overdue ? "text-accent" : "text-white/70"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-semibold text-white">
            {todo.title}
          </span>
          {overdue ? (
            <Badge
              variant="secondary"
              className={homeBadgeClassName("home", "text-accent")}
            >
              Overdue
            </Badge>
          ) : (
            <Badge variant="secondary" className={homeBadgeClassName("home")}>
              Due today
            </Badge>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * The merged goal-attention row (§E item 5): renders the single urgent goal
 * inline in the Today card. Whole-row button so the home 44px target rule holds;
 * tapping opens the Goals view.
 */
function GoalAttentionRow({
  goal,
  onOpen,
  tone = "default",
}: {
  goal: AttentionGoal;
  onOpen: () => void;
  tone?: "default" | "home";
}) {
  const atRisk = goal.reviewState === "at_risk";
  const status = atRisk ? "at risk" : "needs attention";
  const isHome = tone === "home";
  return (
    <button
      type="button"
      data-testid="todo-goal-attention-row"
      aria-label={`Goal "${goal.title}" ${status}. Open Goals.`}
      onClick={onOpen}
      className={`flex min-h-11 w-full items-start gap-2 rounded-sm border p-3 text-left ${
        isHome ? "border-white/15 text-white" : "border-border/50 bg-bg/70"
      }`}
    >
      <Target
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          isHome ? "text-white/75" : atRisk ? "text-danger" : "text-accent"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`min-w-0 truncate text-xs font-semibold ${
              isHome ? "text-white" : "text-txt"
            }`}
          >
            {goal.title}
          </span>
          <Badge
            variant="secondary"
            className={homeBadgeClassName(
              tone,
              atRisk ? "text-danger" : "text-accent",
            )}
          >
            {atRisk ? "At risk" : "Needs attention"}
          </Badge>
        </div>
      </div>
    </button>
  );
}

/**
 * The chat-sidebar content: the agent's workbench checklist, grouped open-first.
 */
function WorkbenchTodoItems({
  todos,
  loading,
}: {
  todos: WorkbenchTodo[];
  loading: boolean;
}) {
  const openTodos = todos.filter((todo) => !todo.isCompleted);
  const hiddenCompletedCount = todos.length - openTodos.length;
  const visibleTodos = openTodos.slice(0, MAX_VISIBLE_TODOS);
  const remainingCount = openTodos.length - visibleTodos.length;

  if (loading && todos.length === 0) {
    return <div className="py-3 text-xs text-muted">Refreshing todos…</div>;
  }

  if (openTodos.length === 0) {
    return (
      <EmptyWidgetState
        icon={<ListTodo className="h-8 w-8" />}
        title="No open todos"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {visibleTodos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} />
      ))}
      {remainingCount > 0 ? (
        <p className="px-1 text-xs-tight text-muted">
          +{remainingCount} more open todo{remainingCount === 1 ? "" : "s"}
        </p>
      ) : null}
      {hiddenCompletedCount > 0 ? (
        <p className="px-1 text-xs-tight text-muted">
          {hiddenCompletedCount} completed todo
          {hiddenCompletedCount === 1 ? "" : "s"} hidden
        </p>
      ) : null}
    </div>
  );
}

/**
 * Fetch the single urgent goal for the merged Today card (§E item 5). Polls at
 * the goals cadence, visibility-gated, and keeps its last-good value on a
 * transient failure (J4). Returns `null` when there is no at-risk or
 * needs-attention goal, so it contributes nothing to the card.
 */
function useAtRiskGoal(): AttentionGoal | null {
  const authenticated = useIsAuthenticated();
  const [goals, setGoals] = useState<AttentionGoal[] | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await loadGoalsForGlance(authenticated);
    // A null return means the fetch failed (J4) - keep the last good value.
    if (next == null || !mountedRef.current) return;
    setGoals((prev) => (goalsEqual(prev, next) ? prev : next));
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(() => void load(), GOALS_REFRESH_INTERVAL_MS);

  if (goals == null) return null;
  return mostUrgentGoal(goals);
}

/**
 * The owner's Today todos read model, driving the home card. Loads through
 * `today-todos-data` (never a store), polls visibility-gated, keeps last-good on
 * a transient failure (J4), and completes a row optimistically: the tapped todo
 * disappears immediately, a successful write is confirmed by the reload, and a
 * failed write restores the row.
 *
 * `now` is state sampled inside the load/poll callbacks — never `Date.now()` in
 * render — so the due/overdue slice recomputes on each 15s tick (surfacing a
 * todo that crosses into overdue) while keeping renders deterministic.
 */
function useTodayTodos(): {
  glance: TodayTodo[] | null;
  now: number;
  hasOverdue: boolean;
  complete: (id: string) => void;
} {
  const authenticated = useIsAuthenticated();
  const [todos, setTodos] = useState<TodayTodo[] | null>(null);
  const [now, setNow] = useState(0);
  const [completingIds, setCompletingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const next = await loadTodayTodosForGlance(authenticated);
    if (!mountedRef.current) return;
    setNow(Date.now());
    // A null return means the fetch failed (J4) - keep the last good value.
    if (next == null) return;
    setTodos((prev) => (todosEqual(prev, next) ? prev : next));
  }, [authenticated]);

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(
    () => void load(),
    TODAY_TODOS_REFRESH_INTERVAL_MS,
  );

  const complete = useCallback(
    (id: string) => {
      setCompletingIds((prev) => new Set(prev).add(id));
      completeTodayTodo(id)
        .then(() => load())
        .catch(() => {
          // error-policy:J4 optimistic write failed - restore the row so the
          // user sees it is still open rather than a silent drop.
          if (!mountedRef.current) return;
          setCompletingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        });
    },
    [load],
  );

  const glance = useMemo(() => {
    if (todos == null) return null;
    return dueOrOverdueToday(todos, now).filter(
      (todo) => !completingIds.has(todo.id),
    );
  }, [todos, now, completingIds]);
  const hasOverdue = useMemo(
    () => (glance ?? []).some((todo) => isOverdue(todo, now)),
    [glance, now],
  );

  return { glance, now, hasOverdue, complete };
}

/**
 * The home "Today" resident: the owner's due/overdue todos as a pure render over
 * the read model, plus the merged urgent-goal row. Publishes its home-attention
 * weight from the STRONGER of its two signals (an at-risk goal outranks an
 * overdue todo), and self-hides when it has nothing to show — the home surface
 * must not paint empty-state placeholders (#9143).
 */
function TodayHomeCard({
  spanClassName = "col-span-2 row-span-1",
}: {
  spanClassName?: string;
}) {
  const t = useAppSelectorShallow((s) => s.t) ?? fallbackTranslate;
  const nav = useWidgetNavigation();
  const { glance, now, hasOverdue, complete } = useTodayTodos();
  const attentionGoal = useAtRiskGoal();

  const rows = glance ?? [];
  const visibleTodos = rows.slice(0, MAX_TODAY_ROWS);
  const remainingCount = rows.length - visibleTodos.length;

  // Float the merged Today card up on the STRONGER of its two signals: an
  // at-risk goal contributes the goals escalation weight (higher than the todo
  // reminder weight), so goal urgency dominates - matching the standalone goals
  // card this absorbed (§E item 5). Both publish under the todo key because the
  // ranker attributes a self-published weight to the declaration whose key
  // matches, and the merged resident IS `todo/todo.items`.
  const homeAttentionWeight = attentionGoal
    ? HOME_SIGNAL_WEIGHTS.escalation
    : hasOverdue
      ? HOME_SIGNAL_WEIGHTS.reminder
      : null;
  usePublishHomeAttention(TODO_WIDGET_KEY, homeAttentionWeight);

  // Nothing due/overdue AND no at-risk goal: the card has no reason to render.
  if (rows.length === 0 && !attentionGoal) return null;

  const goalRow = attentionGoal ? (
    <GoalAttentionRow
      goal={attentionGoal}
      onOpen={() => nav.openView("/goals", "goals")}
      tone="home"
    />
  ) : null;

  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <WidgetSection
        title={t("taskseventspanel.Today", { defaultValue: "Today" })}
        icon={<ListTodo className="h-4 w-4" />}
        testId="chat-widget-todos"
        tone="home"
        onTitleClick={() => nav.openView("/todos", "todos")}
      >
        <div className="flex flex-col gap-2">
          {goalRow}
          {visibleTodos.map((todo) => (
            <TodayTodoRow
              key={todo.id}
              todo={todo}
              now={now}
              onComplete={() => complete(todo.id)}
            />
          ))}
          {remainingCount > 0 ? (
            <p className="px-1 text-xs-tight text-white/70">
              +{remainingCount} more due today
            </p>
          ) : null}
        </div>
      </WidgetSection>
    </div>
  );
}

/**
 * The chat-sidebar Todos widget: the agent's workbench checklist. Seeds from the
 * app store, refreshes on live workbench events, and repairs missed events with
 * a visible-tab poll.
 */
function WorkbenchTodoSidebar({ events }: ChatSidebarWidgetProps) {
  const { workbench } = useAppSelectorShallow((s) => ({
    workbench: s.workbench,
  }));
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 15s todo poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();
  const [todos, setTodos] = useState<WorkbenchTodo[]>(() =>
    dedupeTodos(workbench?.todos ?? []),
  );
  const [todosLoading, setTodosLoading] = useState(false);
  const lastHandledTodoEventIdRef = useRef<string | null>(null);

  // The async todo fetch can resolve after the widget unmounts; guard the
  // post-await state writes so a late `finally` doesn't setState on an
  // unmounted component (which throws once the host environment is gone).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setTodos(dedupeTodos(workbench?.todos ?? []));
  }, [workbench?.todos]);

  const loadTodos = useCallback(
    async (silent = false) => {
      if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
        if (mountedRef.current) {
          setTodos(dedupeTodos(workbench?.todos ?? []));
          setTodosLoading(false);
        }
        return;
      }

      if (!silent && mountedRef.current) {
        setTodosLoading(true);
      }

      try {
        const result = await client.listWorkbenchTodos();
        if (mountedRef.current) {
          setTodos(dedupeTodos(result.todos));
        }
      } catch {
        // error-policy:J4 glance tile - fall back to the workbench snapshot
        // already in view state rather than surfacing a broken card.
        if (mountedRef.current && (workbench?.todos?.length ?? 0) > 0) {
          setTodos(dedupeTodos(workbench?.todos ?? []));
        }
      } finally {
        if (mountedRef.current) {
          setTodosLoading(false);
        }
      }
    },
    [authenticated, workbench?.todos],
  );

  useEffect(() => {
    void loadTodos(todos.length > 0);
  }, [loadTodos, todos.length]);

  useEffect(() => {
    const latestTodoEvent = events.find(isWorkbenchTodoChangeEvent);
    if (
      !latestTodoEvent ||
      latestTodoEvent.id === lastHandledTodoEventIdRef.current
    ) {
      return;
    }
    lastHandledTodoEventIdRef.current = latestTodoEvent.id;
    void loadTodos(true);
  }, [events, loadTodos]);

  // Refresh only while the document is visible - pause the silent poll in a
  // backgrounded app/tab. Live workbench events do the normal foreground
  // refresh; this poll is just a missed-event repair path.
  useIntervalWhenDocumentVisible(
    () => void loadTodos(true),
    TODO_REFRESH_INTERVAL_MS,
  );

  const { t: appT } = useAppSelectorShallow((s) => ({ t: s.t }));
  const t = appT ?? fallbackTranslate;

  return (
    <WidgetSection
      title={t("taskseventspanel.Todos", { defaultValue: "Todos" })}
      icon={<ListTodo className="h-4 w-4" />}
      testId="chat-widget-todos"
    >
      <WorkbenchTodoItems todos={todos} loading={todosLoading} />
    </WidgetSection>
  );
}

/**
 * Widget-host entry: dispatches to the home "Today" card (owner todos read
 * model) or the chat-sidebar workbench checklist by slot. They are separate
 * surfaces backed by separate reads; the host renders whichever the slot needs.
 */
function TodoSidebarWidget(props: ChatSidebarWidgetProps) {
  if (props.slot === "home") {
    return <TodayHomeCard spanClassName={props.spanClassName} />;
  }
  return <WorkbenchTodoSidebar {...props} />;
}

export const TODO_PLUGIN_WIDGETS: ChatSidebarWidgetDefinition[] = [
  {
    id: "todo.items",
    pluginId: "todo",
    order: 100,
    defaultEnabled: true,
    Component: TodoSidebarWidget,
  },
];
