/** Agent workbench checklist for chat-side and inline widget surfaces. */

import type { TranslateFn, WorkbenchTodo } from "@elizaos/contracts";
import { ListTodo } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { client } from "../../../api/client";

import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import { useAppSelectorShallow } from "../../../state/app-store";
import { Badge } from "../../ui/badge";
import { EmptyWidgetState, WidgetSection } from "./shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

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

function TodoRow({ todo }: { todo: WorkbenchTodo }) {
  const showDescription =
    todo.description.trim().length > 0 && todo.description !== todo.name;
  const showType = todo.type.trim().length > 0 && todo.type !== "task";

  return (
    <div data-testid="workbench-todo-row" className="py-1.5">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${
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
              <Badge variant="secondary" tone="danger">
                Urgent
              </Badge>
            ) : null}
            {todo.priority != null ? (
              <Badge variant="secondary" size="micro" tone="muted">
                P{todo.priority}
              </Badge>
            ) : null}
            {showType ? (
              <Badge variant="secondary" size="micro" tone="muted">
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
        icon={<ListTodo className="size-8" />}
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
      icon={<ListTodo className="size-4" />}
      testId="chat-widget-todos"
    >
      <WorkbenchTodoItems todos={todos} loading={todosLoading} />
    </WidgetSection>
  );
}

/** Stale/direct Home callers cannot restore the retired Today projection. */
function TodoSidebarWidget(props: ChatSidebarWidgetProps) {
  if (props.slot === "home") return null;
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
