/**
 * Read model for the home "Today" card (todo.tsx, spec §B.3).
 *
 * The Today resident glances the OWNER's due/overdue todos — not the agent's
 * workbench checklist. Those live behind the single owner-todos read the PA
 * plugin serves (`GET /api/lifeops/todos`, a projection of the shared
 * scheduled-task spine), each carrying a `dueDate` the workbench store lacks.
 * This module is the card's read path: it validates that untrusted wire at the
 * network boundary into the typed {@link TodayTodo} DTO, selects the
 * due/overdue-today slice the glance shows, and completes a row through the
 * canonical `POST /api/lifeops/occurrences/:id/complete` write. The card is a
 * pure renderer over these results — it never reaches into a store.
 *
 * Kept dependency-light (no React) so the parsing, the today-window filter, and
 * the completion write are unit-testable in isolation. Mirrors the shape of the
 * sibling `goals-attention-data.ts` glance read model.
 */

import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";

/** Home-card poll cadence — matches the TodosView 15s background refresh. */
export const TODAY_TODOS_REFRESH_INTERVAL_MS = 15_000;

/** The item-board status the PA todos route projects each occurrence onto. */
export type TodayTodoStatus = "pending" | "in_progress" | "completed";

const KNOWN_STATUSES: ReadonlySet<string> = new Set<TodayTodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

/**
 * An owner todo flattened for the Today glance. Only due-dated todos become a
 * `TodayTodo` (a glance is about "due today / overdue"; an undated backlog item
 * is not glanceable), so `dueDate` is required — never nullable — here.
 */
export interface TodayTodo {
  id: string;
  title: string;
  dueDate: string;
  status: TodayTodoStatus;
}

function toStatus(value: unknown): TodayTodoStatus {
  return typeof value === "string" && KNOWN_STATUSES.has(value)
    ? (value as TodayTodoStatus)
    : "pending";
}

/**
 * Validate + flatten the untrusted `{ todos: [{ id, title, status, dueDate }] }`
 * payload at the network boundary, dropping any record missing an id/title or a
 * usable due date. A record with a null/unparseable `dueDate` is not a Today
 * candidate and is dropped here rather than carried as a nullable field.
 */
export function parseTodayTodos(payload: unknown): TodayTodo[] {
  if (typeof payload !== "object" || payload === null) return [];
  const records = (payload as { todos?: unknown }).todos;
  if (!Array.isArray(records)) return [];

  const todos: TodayTodo[] = [];
  for (const record of records) {
    if (typeof record !== "object" || record === null) continue;
    const { id, title, status, dueDate } = record as {
      id?: unknown;
      title?: unknown;
      status?: unknown;
      dueDate?: unknown;
    };
    if (typeof id !== "string" || typeof title !== "string") continue;
    if (typeof dueDate !== "string" || Number.isNaN(Date.parse(dueDate))) {
      continue;
    }
    todos.push({ id, title, dueDate, status: toStatus(status) });
  }
  return todos;
}

/** True when the todo is not yet done. */
export function isOpen(todo: TodayTodo): boolean {
  return todo.status !== "completed";
}

/** True when the todo's due date is strictly before the start of `now`'s day. */
export function isOverdue(todo: TodayTodo, now: number): boolean {
  const due = Date.parse(todo.dueDate);
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  return due < startOfToday;
}

/**
 * The glance slice (spec §B.3): open todos due today or already overdue, sorted
 * most-overdue first so the item that has slipped longest leads. A due date past
 * the end of today is a backlog item, not a glance, and is excluded.
 */
export function dueOrOverdueToday(
  todos: TodayTodo[],
  now: number,
): TodayTodo[] {
  const endOfToday = new Date(now).setHours(23, 59, 59, 999);
  return todos
    .filter((todo) => isOpen(todo) && Date.parse(todo.dueDate) <= endOfToday)
    .sort(
      (left, right) => Date.parse(left.dueDate) - Date.parse(right.dueDate),
    );
}

/** Count of the glance slice that is already overdue — drives the card's rank. */
export function overdueCount(todos: TodayTodo[], now: number): number {
  return dueOrOverdueToday(todos, now).filter((todo) => isOverdue(todo, now))
    .length;
}

export async function fetchTodayTodos(): Promise<TodayTodo[]> {
  const response = await fetch(`${client.getBaseUrl()}/api/lifeops/todos`);
  if (!response.ok) {
    throw new Error(`Todos request failed (${response.status})`);
  }
  return parseTodayTodos(await response.json());
}

/**
 * Complete an owner todo through the canonical occurrence-complete write. The
 * caller applies the row optimistically and reloads; a rejected promise lets the
 * caller roll the optimistic completion back.
 */
export async function completeTodayTodo(id: string): Promise<void> {
  const response = await fetch(
    `${client.getBaseUrl()}/api/lifeops/occurrences/${encodeURIComponent(id)}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`Complete todo failed (${response.status})`);
  }
}

/** Shallow content equality so an unchanged poll doesn't re-render the card. */
export function todosEqual(a: TodayTodo[] | null, b: TodayTodo[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((todo, i) => {
    const other = b[i];
    return (
      todo.id === other.id &&
      todo.title === other.title &&
      todo.dueDate === other.dueDate &&
      todo.status === other.status
    );
  });
}

/**
 * Best-effort owner-todos fetch for the glance: honors the auth gate and the
 * limited-cloud-base guard, and swallows fetch errors (returns `null` so the
 * caller keeps its last-good render, todo.tsx J4 pattern). Returns `[]` when
 * gated so the caller resolves to "loaded, empty" rather than "still pending".
 */
export async function loadTodayTodosForGlance(
  authenticated: boolean,
): Promise<TodayTodo[] | null> {
  if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
    return [];
  }
  try {
    return await fetchTodayTodos();
  } catch {
    // error-policy:J4 glance surface - signal "keep last good" to the caller.
    return null;
  }
}
