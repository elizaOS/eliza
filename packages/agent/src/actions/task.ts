/**
 * TASK — workbench task CRUD as a Pattern-C op-dispatch action.
 *
 * Ops:
 *   create   — create a workbench task
 *   update   — rename / re-describe an existing task
 *   complete — mark a task complete
 *   delete   — remove a task
 *   list     — list all workbench tasks for this agent
 *
 * Workbench tasks are persisted runtime Tasks tagged with
 * {@link WORKBENCH_TASK_TAG} and surfaced in the workbench UI. They are
 * distinct from trigger tasks (TRIGGER action) and from todos
 * (plugin-todos / TODO action).
 */
import {
  type Action,
  type ActionExample,
  type ActionResult,
  asUUID,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  type Task,
  type UUID,
} from "@elizaos/core";
import {
  readTaskMetadata,
  toWorkbenchTask,
  WORKBENCH_TASK_TAG,
} from "../api/workbench-helpers.js";
import { readTriggerConfig } from "../triggers/runtime.js";

const TASK_OPS = ["create", "update", "complete", "delete", "list"] as const;
type TaskOp = (typeof TASK_OPS)[number];

const TASK_ACTION = "TASK";

interface TaskParameters {
  op?: string;
  taskId?: string;
  name?: string;
  description?: string;
}

function readParams(options?: HandlerOptions): TaskParameters {
  const raw = options?.parameters;
  if (!raw || typeof raw !== "object") return {};
  return raw as TaskParameters;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readUuid(value: unknown): UUID | undefined {
  const str = readString(value);
  return str ? asUUID(str) : undefined;
}

function failed(
  op: TaskOp | string,
  text: string,
  error?: string,
  data?: Record<string, unknown>,
): ActionResult {
  const code = `TASK_${op.toUpperCase()}_FAILED`;
  return {
    success: false,
    text,
    error: error ?? code,
    values: { op, error: error ?? code },
    data: { actionName: TASK_ACTION, op, error: error ?? code, ...data },
  };
}

function ok(
  op: TaskOp,
  text: string,
  data?: Record<string, unknown>,
  values?: Record<string, unknown>,
): ActionResult {
  return {
    success: true,
    text,
    values: { op, ...(values ?? {}) },
    data: { actionName: TASK_ACTION, op, ...(data ?? {}) },
  };
}

function isTaskOp(value: string): value is TaskOp {
  return (TASK_OPS as readonly string[]).includes(value);
}

async function opCreate(
  runtime: IAgentRuntime,
  message: Memory,
  params: TaskParameters,
): Promise<ActionResult> {
  const name =
    readString(params.name) ??
    readString(params.description) ??
    readString(message.content.text)?.slice(0, 100);
  if (!name) {
    return failed("create", "Task name is required.", "MISSING_NAME");
  }
  const description = readString(params.description) ?? "";
  const taskId = await runtime.createTask({
    name,
    description,
    tags: [WORKBENCH_TASK_TAG],
    metadata: { isCompleted: false, workbench: { kind: "task" } },
  });
  return ok(
    "create",
    `Created task "${name}".`,
    { taskId: String(taskId) },
    { taskId: String(taskId) },
  );
}

async function opUpdate(
  runtime: IAgentRuntime,
  params: TaskParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("update", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed("update", `Task not found: ${taskId}`, "TASK_NOT_FOUND");
  const update: Partial<Task> = {};
  const name = readString(params.name);
  const description = readString(params.description);
  if (name) update.name = name;
  if (description !== undefined) update.description = description;
  if (Object.keys(update).length === 0) {
    return failed("update", "No updatable fields supplied.", "NO_FIELDS");
  }
  await runtime.updateTask(task.id, update);
  return ok("update", `Updated task "${name ?? task.name}".`, {
    taskId: String(task.id),
  });
}

async function opComplete(
  runtime: IAgentRuntime,
  params: TaskParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("complete", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed("complete", `Task not found: ${taskId}`, "TASK_NOT_FOUND");
  const metadata = readTaskMetadata(task);
  await runtime.updateTask(task.id, {
    metadata: { ...metadata, isCompleted: true },
  });
  return ok("complete", `Completed task "${task.name}".`, {
    taskId: String(task.id),
  });
}

async function opDelete(
  runtime: IAgentRuntime,
  params: TaskParameters,
): Promise<ActionResult> {
  const taskId = readUuid(params.taskId);
  if (!taskId)
    return failed("delete", "taskId is required.", "MISSING_TASK_ID");
  const task = await runtime.getTask(taskId);
  if (!task?.id)
    return failed("delete", `Task not found: ${taskId}`, "TASK_NOT_FOUND");
  await runtime.deleteTask(task.id);
  return ok("delete", `Deleted task "${task.name}".`, {
    taskId: String(task.id),
  });
}

async function opList(runtime: IAgentRuntime): Promise<ActionResult> {
  const allTasks = await runtime.getTasks({ agentIds: [runtime.agentId] });
  const workbenchTasks = allTasks.filter(
    (t) => !readTriggerConfig(t) && toWorkbenchTask(t) !== null,
  );
  if (workbenchTasks.length === 0) {
    return ok("list", "You have no tasks right now.", { tasks: [] });
  }
  const lines = workbenchTasks.map((t) => {
    const meta = readTaskMetadata(t);
    const done = meta.isCompleted === true;
    const desc = t.description ? ` — ${t.description}` : "";
    return `${done ? "✓" : "○"} ${t.name}${desc}`;
  });
  return ok("list", `Your tasks:\n${lines.join("\n")}`, {
    tasks: workbenchTasks.map((t) => ({
      id: t.id ?? "",
      name: t.name,
      description: t.description ?? "",
      isCompleted: readTaskMetadata(t).isCompleted === true,
    })),
  });
}

export const taskAction: Action = {
  name: TASK_ACTION,
  contexts: ["tasks", "automation", "agent_internal"],
  roleGate: { minRole: "ADMIN" },
  similes: [],
  description:
    "Workbench task CRUD. Op-based dispatch (create / update / complete / delete / list).",
  descriptionCompressed:
    "workbench task CRUD: create update complete delete list",
  suppressPostActionContinuation: true,

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
  ): Promise<boolean> => {
    const op = readString(readParams(options).op);
    return op !== undefined && isTaskOp(op);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const opRaw = readString(params.op)?.toLowerCase();
    if (!opRaw || !isTaskOp(opRaw)) {
      const result = failed(
        "invalid",
        `Invalid op. Expected one of: ${TASK_OPS.join(", ")}.`,
        "TASK_INVALID",
      );
      if (callback) {
        await callback({ text: result.text ?? "", action: TASK_ACTION });
      }
      return result;
    }
    const op: TaskOp = opRaw;

    let result: ActionResult;
    switch (op) {
      case "create":
        result = await opCreate(runtime, message, params);
        break;
      case "update":
        result = await opUpdate(runtime, params);
        break;
      case "complete":
        result = await opComplete(runtime, params);
        break;
      case "delete":
        result = await opDelete(runtime, params);
        break;
      case "list":
        result = await opList(runtime);
        break;
    }

    if (callback) {
      await callback({
        text: result.text ?? "",
        action: TASK_ACTION,
        metadata: { op, ...(result.values ?? {}) },
      });
    }
    return result;
  },

  parameters: [
    {
      name: "op",
      description: `Sub-action: ${TASK_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string" as const, enum: [...TASK_OPS] },
    },
    {
      name: "taskId",
      description: "Target task UUID. Required for update / complete / delete.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Task name (create / update).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "description",
      description: "Task description (create / update).",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Add a todo to buy groceries tomorrow." },
      },
      {
        name: "{{agent}}",
        content: {
          text: 'Created task "buy groceries tomorrow".',
          action: TASK_ACTION,
        },
      },
    ],
    [
      {
        name: "{{user}}",
        content: { text: "What's on my task list?" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Your tasks:\n○ buy groceries tomorrow",
          action: TASK_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};

export { TASK_OPS };
