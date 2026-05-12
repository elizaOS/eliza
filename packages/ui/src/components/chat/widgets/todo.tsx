import { Badge } from "../../ui/badge";
import { ListTodo } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
import type { WorkbenchTodo } from "../../../api/client-types-config";
import { useApp } from "../../../state";
import type { TranslateFn } from "../../../types";
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

function TodoRow({ todo }: { todo: WorkbenchTodo }) {
  const showDescription =
    todo.description.trim().length > 0 && todo.description !== todo.name;
  const showType = todo.type.trim().length > 0 && todo.type !== "task";

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-3">
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

function TodoSidebarWidget(_props: ChatSidebarWidgetProps) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const workbench = app?.workbench;
  const t = app?.t ?? fallbackTranslate;
  const [todos, setTodos] = useState<WorkbenchTodo[]>(() =>
    dedupeTodos(workbench?.todos ?? []),
  );
  const [todosLoading, setTodosLoading] = useState(false);

  useEffect(() => {
    setTodos(dedupeTodos(workbench?.todos ?? []));
  }, [workbench?.todos]);

  const loadTodos = useCallback(
    async (silent = false) => {
      if (!silent) {
        setTodosLoading(true);
      }

      try {
        const result = await client.listWorkbenchTodos();
        setTodos(dedupeTodos(result.todos));
      } catch {
        if ((workbench?.todos?.length ?? 0) > 0) {
          setTodos(dedupeTodos(workbench?.todos ?? []));
        }
      } finally {
        setTodosLoading(false);
      }
    },
    [workbench?.todos],
  );

  useEffect(() => {
    let active = true;

    void (async () => {
      await loadTodos(todos.length > 0);
      if (!active) return;
    })();

    const intervalId = setInterval(() => {
      if (!active) return;
      void loadTodos(true);
    }, TODO_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [loadTodos, todos.length]);

  return (
    <WidgetSection
      title={t("taskseventspanel.Todos", { defaultValue: "Todos" })}
      icon={<ListTodo className="h-4 w-4" />}
      testId="chat-widget-todos"
    >
      <TodoItemsContent todos={todos} loading={todosLoading} />
    </WidgetSection>
  );
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
