/** Pure workbench projections shared by agent hosts and workflow routes. */
import type { WorkbenchTask, WorkbenchTodo } from "@elizaos/contracts";
import type { Task } from "@elizaos/core";

export const WORKBENCH_TODO_TAG = "workbench-todo";
export const WORKBENCH_TASK_TAG = "workbench-task";

function hasTaskTrigger(task: Task): boolean {
  return Boolean(asObject(readTaskMetadata(task).trigger)?.triggerId);
}

export function readWorkbenchTodoMetadata(task: Task): Record<string, unknown> {
  const metadata = readTaskMetadata(task);
  return asObject(metadata.workbenchTodo) ?? asObject(metadata.todo) ?? {};
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeWorkbenchTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseWorkbenchTodoPriority(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readTaskMetadata(task: Task): Record<string, unknown> {
  return asObject(task.metadata) ?? {};
}

function normalizeTaskId(task: Task): string | null {
  return typeof task.id === "string" && task.id.trim().length > 0
    ? task.id
    : null;
}

export function readTaskCompleted(task: Task): boolean {
  const metadata = readTaskMetadata(task);
  if (typeof metadata.isCompleted === "boolean") return metadata.isCompleted;
  return readWorkbenchTodoMetadata(task).isCompleted === true;
}

export function isWorkbenchTodoTask(task: Task): boolean {
  if (hasTaskTrigger(task)) return false;
  const tags = new Set(normalizeWorkbenchTags(task.tags));
  if (tags.has(WORKBENCH_TODO_TAG) || tags.has("todo")) return true;
  const metadata = readTaskMetadata(task);
  return (
    asObject(metadata.workbenchTodo) !== null ||
    asObject(metadata.todo) !== null
  );
}

export function toWorkbenchTodo(task: Task): WorkbenchTodo | null {
  if (!isWorkbenchTodoTask(task)) return null;
  const id = normalizeTaskId(task);
  if (!id) return null;
  const todoMeta = readWorkbenchTodoMetadata(task);
  return {
    id,
    name:
      typeof task.name === "string" && task.name.trim().length > 0
        ? task.name
        : "Todo",
    description:
      typeof todoMeta.description === "string"
        ? todoMeta.description
        : typeof task.description === "string"
          ? task.description
          : "",
    priority: parseWorkbenchTodoPriority(todoMeta.priority),
    isUrgent: todoMeta.isUrgent === true,
    isCompleted: readTaskCompleted(task),
    type:
      typeof todoMeta.type === "string" && todoMeta.type.trim().length > 0
        ? todoMeta.type
        : "task",
    tags: normalizeWorkbenchTags(task.tags),
    createdAt: task.createdAt
      ? new Date(Number(task.createdAt)).toISOString()
      : null,
    updatedAt: task.updatedAt
      ? new Date(Number(task.updatedAt)).toISOString()
      : null,
  };
}

export function toWorkbenchTask(task: Task): WorkbenchTask | null {
  const tags = normalizeWorkbenchTags(task.tags);
  if (!tags.includes(WORKBENCH_TASK_TAG)) return null;
  if (hasTaskTrigger(task) || isWorkbenchTodoTask(task)) return null;
  const id = normalizeTaskId(task);
  if (!id) return null;
  const metadata = readTaskMetadata(task);
  const updatedAt =
    normalizeTimestamp((task as { updatedAt?: unknown }).updatedAt) ??
    normalizeTimestamp(metadata.updatedAt);
  return {
    id,
    name:
      typeof task.name === "string" && task.name.trim().length > 0
        ? task.name
        : "Task",
    description: typeof task.description === "string" ? task.description : "",
    tags,
    isCompleted: readTaskCompleted(task),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
