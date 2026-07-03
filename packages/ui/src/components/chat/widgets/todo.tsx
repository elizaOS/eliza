import { ListTodo } from "lucide-react";
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

function TodoRow({ todo }: { todo: WorkbenchTodo }) {
  const showDescription =
    todo.description.trim().length > 0 && todo.description !== todo.name;
  const showType = todo.type.trim().length > 0 && todo.type !== "task";

  return (
    <div className="rounded-sm border border-border/50 bg-bg/70 p-3">
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
            <span className="min-w-0 truncate text-xs font-semibold text-txt">
              {todo.name}
            </span>
            {todo.isUrgent ? (
              <Badge variant="secondary" className="text-3xs text-danger">
                Urgent
              </Badge>
            ) : null}
            {todo.priority != null ? (
              <Badge variant="secondary" className="text-3xs">
                P{todo.priority}
              </Badge>
            ) : null}
            {showType ? (
              <Badge variant="secondary" className="text-3xs">
                {todo.type}
              </Badge>
            ) : null}
          </div>
          {showDescription ? (
            <p className="mt-1 line-clamp-2 text-xs-tight leading-5 text-muted">
              {todo.description}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TodoItemsContent({
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

function TodoSidebarWidget({
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
  // Refresh only while the document is visible — pause the silent poll in a
  // backgrounded app/tab instead of refetching the todo list every interval.
  useIntervalWhenDocumentVisible(
    () => void loadTodos(true),
    TODO_REFRESH_INTERVAL_MS,
  );

  const openTodos = todos.filter((todo) => !todo.isCompleted);
  const hasUrgent = openTodos.some((todo) => todo.isUrgent);
  const onHome = slot === "home";
  // Float the home card up when there are urgent open todos; clear otherwise.
  usePublishHomeAttention(
    TODO_WIDGET_KEY,
    onHome && hasUrgent ? HOME_SIGNAL_WEIGHTS.reminder : null,
  );

  // On the home grid, render nothing when there are no open todos — the home
  // surface must not show empty-state placeholders (#9143). The chat sidebar
  // keeps its empty state.
  if (onHome && openTodos.length === 0) return null;

  const section = (
    <WidgetSection
      title={t("taskseventspanel.Todos", { defaultValue: "Todos" })}
      icon={<ListTodo className="h-4 w-4" />}
      testId="chat-widget-todos"
    >
      <TodoItemsContent todos={todos} loading={todosLoading} />
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
