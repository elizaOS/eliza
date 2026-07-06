/**
 * Chat-sidebar (and home-grid) TODO widget: lists the agent workbench's todos,
 * seeded from the app store's `workbench.todos`, refreshed on live workbench
 * events, and backed by a visible-tab poll for missed events. Exports
 * `TODO_PLUGIN_WIDGETS`, the widget-registry entry consumed by the sidebar.
 *
 * On the home surface this is the "Today" card, and per spec §B/§E item 5 it
 * absorbs the goals resident: when the goals store reports an at-risk (or
 * needs-attention) goal, that goal renders as one flagged row inside this card
 * rather than as a second standalone home widget. The card then self-publishes
 * the goals escalation weight so the merged card floats up on goal urgency.
 */
import { ListTodo, Target } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

const TODO_WIDGET_KEY = "todo/todo.items";

const TODO_REFRESH_INTERVAL_MS = 15_000;
const MAX_VISIBLE_TODOS = 8;

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
            todo.isUrgent
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
        isHome
          ? "border-white/15 bg-white/10 text-white"
          : "border-border/50 bg-bg/70"
      }`}
    >
      <Target
        className={`mt-0.5 h-4 w-4 shrink-0 ${atRisk ? "text-danger" : "text-accent"}`}
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

function TodoItemsContent({
  todos,
  loading,
  goal,
  onOpenGoal,
  tone = "default",
}: {
  todos: WorkbenchTodo[];
  loading: boolean;
  goal: AttentionGoal | null;
  onOpenGoal: () => void;
  tone?: "default" | "home";
}) {
  const openTodos = todos.filter((todo) => !todo.isCompleted);
  const hiddenCompletedCount = todos.length - openTodos.length;
  const visibleTodos = openTodos.slice(0, MAX_VISIBLE_TODOS);
  const remainingCount = openTodos.length - visibleTodos.length;
  const goalRow = goal ? (
    <GoalAttentionRow goal={goal} onOpen={onOpenGoal} tone={tone} />
  ) : null;

  if (loading && todos.length === 0 && !goal) {
    return (
      <div
        className={`py-3 text-xs ${tone === "home" ? "text-white/70" : "text-muted"}`}
      >
        Refreshing todos…
      </div>
    );
  }

  if (openTodos.length === 0) {
    // A flagged goal alone still gives the card a reason to render; only a fully
    // empty Today (no open todos AND no at-risk goal) shows the empty state
    // (which the sidebar surface uses; the home surface hides entirely).
    if (goalRow) {
      return <div className="flex flex-col gap-2">{goalRow}</div>;
    }
    return (
      <EmptyWidgetState
        icon={<ListTodo className="h-8 w-8" />}
        title="No open todos"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {goalRow}
      {visibleTodos.map((todo) => (
        <TodoRow key={todo.id} todo={todo} tone={tone} />
      ))}
      {remainingCount > 0 ? (
        <p
          className={`px-1 text-xs-tight ${tone === "home" ? "text-white/70" : "text-muted"}`}
        >
          +{remainingCount} more open todo{remainingCount === 1 ? "" : "s"}
        </p>
      ) : null}
      {hiddenCompletedCount > 0 ? (
        <p
          className={`px-1 text-xs-tight ${tone === "home" ? "text-white/70" : "text-muted"}`}
        >
          {hiddenCompletedCount} completed todo
          {hiddenCompletedCount === 1 ? "" : "s"} hidden
        </p>
      ) : null}
    </div>
  );
}

/**
 * Fetch the single urgent goal for the merged Today card (§E item 5). Only
 * active on the home surface; the chat-sidebar Todos widget never surfaces
 * goals. Polls at the goals cadence, visibility-gated, and keeps its last-good
 * value on a transient failure (J4). Returns `null` when there is no at-risk or
 * needs-attention goal (or off-home), so it contributes nothing to the card.
 */
function useAtRiskGoal(active: boolean): AttentionGoal | null {
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
    if (!active) return;
    const next = await loadGoalsForGlance(authenticated);
    // A null return means the fetch failed (J4) - keep the last good value.
    if (next == null || !mountedRef.current) return;
    setGoals((prev) => (goalsEqual(prev, next) ? prev : next));
  }, [active, authenticated]);

  useEffect(() => {
    if (!active) {
      setGoals(null);
      return;
    }
    void load();
  }, [active, load]);
  useIntervalWhenDocumentVisible(
    () => void load(),
    GOALS_REFRESH_INTERVAL_MS,
    active,
  );

  if (!active || goals == null) return null;
  return mostUrgentGoal(goals);
}

function TodoSidebarWidget({
  events,
  slot,
  spanClassName = "col-span-2 row-span-1",
}: ChatSidebarWidgetProps) {
  const { workbench, t: appT } = useAppSelectorShallow((s) => ({
    workbench: s.workbench,
    t: s.t,
  }));
  const t = appT ?? fallbackTranslate;
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

  const openTodos = todos.filter((todo) => !todo.isCompleted);
  const hasUrgent = openTodos.some((todo) => todo.isUrgent);
  const onHome = slot === "home";
  // The merged at-risk goal row (§E item 5) is home-only; the chat sidebar
  // keeps the pure todo list.
  const nav = useWidgetNavigation();
  const attentionGoal = useAtRiskGoal(onHome);
  // Float the merged Today card up on the STRONGER of its two signals: an
  // at-risk goal contributes the goals escalation weight (higher than the todo
  // reminder weight), so goal urgency dominates - matching the standalone goals
  // card this absorbed (§E item 5). Both publish under the todo key because the
  // ranker attributes a self-published weight to the declaration whose key
  // matches, and the merged resident IS `todo/todo.items` now.
  const homeAttentionWeight =
    onHome && attentionGoal
      ? HOME_SIGNAL_WEIGHTS.escalation
      : onHome && hasUrgent
        ? HOME_SIGNAL_WEIGHTS.reminder
        : null;
  usePublishHomeAttention(TODO_WIDGET_KEY, homeAttentionWeight);

  // On the home grid, render nothing when there are no open todos AND no at-risk
  // goal - the home surface must not show empty-state placeholders (#9143). A
  // flagged goal alone keeps the merged Today card alive. The chat sidebar keeps
  // its empty state.
  if (onHome && openTodos.length === 0 && !attentionGoal) return null;

  const section = (
    <WidgetSection
      title={t("taskseventspanel.Todos", { defaultValue: "Todos" })}
      icon={<ListTodo className="h-4 w-4" />}
      testId="chat-widget-todos"
      tone={onHome ? "home" : "default"}
    >
      <TodoItemsContent
        todos={todos}
        loading={todosLoading}
        goal={attentionGoal}
        onOpenGoal={() => nav.openView("/goals", "goals")}
        tone={onHome ? "home" : "default"}
      />
    </WidgetSection>
  );
  // On the home 4-col grid the widget's root element must carry its grid-span
  // classes or it collapses to a one-column cell and its content paints over
  // the neighboring card (#11752). The sidebar stack renders the bare section.
  if (onHome) {
    return <div className={`min-w-0 ${spanClassName}`}>{section}</div>;
  }
  return section;
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
