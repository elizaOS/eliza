import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { CodeTaskService } from "../services/code-task.js";

function getTaskService(runtime: IAgentRuntime): CodeTaskService {
  const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
  if (!service) {
    throw new Error(
      "CodeTaskService not found. Is the eliza-code plugin loaded?",
    );
  }
  return service;
}

// ============================================================================
// List Tasks Action
// ============================================================================

export const listTasksAction: Action = {
  name: "LIST_TASKS",
  similes: ["SHOW_TASKS", "GET_TASKS", "TASKS", "VIEW_TASKS"],
  description: `Display all tasks with their status, progress, and organization by state.

USE THIS ACTION WHEN:
- User says "list tasks", "show tasks", "my tasks", or "all tasks"
- User asks about task status or what's running
- User wants an overview of pending, running, or completed work

DO NOT USE WHEN:
- User wants to create a new task (use CREATE_TASK)
- User wants to search for specific tasks (use SEARCH_TASKS)
- User wants to switch to a task (use SWITCH_TASK)

OUTPUT: Tasks grouped by status (running, pending, paused, completed, failed, cancelled) with progress percentages.`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("list task") ||
      text.includes("show task") ||
      text.includes("my task") ||
      text.includes("all task") ||
      (text.includes("task") && text.includes("status"))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const tasks = await service.getRecentTasks(20);

      if (tasks.length === 0) {
        const msg = "No tasks.";
        await callback?.({ text: msg });
        return { success: true, text: msg };
      }

      const currentId = service.getCurrentTaskId();
      const lines: string[] = ["Tasks:"];

      const byStatus = {
        running: tasks.filter((t) => t.metadata.status === "running"),
        pending: tasks.filter((t) => t.metadata.status === "pending"),
        paused: tasks.filter((t) => t.metadata.status === "paused"),
        completed: tasks.filter((t) => t.metadata.status === "completed"),
        failed: tasks.filter((t) => t.metadata.status === "failed"),
        cancelled: tasks.filter((t) => t.metadata.status === "cancelled"),
      };

      for (const [status, statusTasks] of Object.entries(byStatus)) {
        if (statusTasks.length === 0) continue;
        lines.push(
          `${getStatusSymbol(status)} ${capitalize(status)} (${statusTasks.length}):`,
        );
        for (const task of statusTasks) {
          const current = task.id === currentId ? " (current)" : "";
          lines.push(`- ${task.name} (${task.metadata.progress}%)${current}`);
        }
      }

      const result = lines.join("\n");
      await callback?.({ text: result });
      return { success: true, text: result, data: { count: tasks.length } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`LIST_TASKS error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "show me my tasks" } },
      {
        name: "{{agent}}",
        content: { text: "Here are your tasks:", actions: ["LIST_TASKS"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "what tasks are running?" } },
      {
        name: "{{agent}}",
        content: { text: "Let me check...", actions: ["LIST_TASKS"] },
      },
    ],
  ],
};

// ============================================================================
// Switch Task Action
// ============================================================================

export const switchTaskAction: Action = {
  name: "SWITCH_TASK",
  similes: ["SELECT_TASK", "SET_TASK", "CHANGE_TASK", "GO_TO_TASK"],
  description: `Switch the current task context to a different task by name or ID.

USE THIS ACTION WHEN:
- User says "switch to task", "select task", or "go to task"
- User wants to change which task is currently active
- User wants to view or work on a different task

DO NOT USE WHEN:
- User wants to list all tasks (use LIST_TASKS)
- User wants to search without switching (use SEARCH_TASKS)
- User wants to resume a paused task (use RESUME_TASK)

BEHAVIOR:
- Searches for task by name or partial match
- If multiple matches found, asks for clarification
- Sets the matched task as current context`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("switch to task") ||
      text.includes("select task") ||
      text.includes("go to task") ||
      text.includes("show task") ||
      (text.includes("task") &&
        (text.includes("switch") || text.includes("select")))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const text = message.content.text ?? "";

      // Extract task query from message
      const query = extractTaskQuery(text);
      if (!query) {
        const msg = "Please specify which task to switch to (by name or ID).";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const matches = await service.searchTasks(query);

      if (matches.length === 0) {
        const msg = `No task found matching: "${query}"`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      if (matches.length === 1) {
        const task = matches[0];
        const taskId = task.id;
        if (!taskId) {
          const msg = `Task "${task.name}" has no id and cannot be selected.`;
          await callback?.({ text: msg });
          return { success: false, text: msg };
        }

        service.setCurrentTask(taskId);
        const msg = `Switched to task: ${task.name} (${task.metadata.status}, ${task.metadata.progress}%)`;
        await callback?.({ text: msg });
        return { success: true, text: msg, data: { taskId } };
      }

      // Multiple matches - ask for clarification
      const list = matches
        .slice(0, 5)
        .map((t, i) => `${i + 1}. ${t.name} (${t.metadata.status})`)
        .join("\n");
      const msg = `Found ${matches.length} matching tasks:\n${list}\n\nWhich one?`;
      await callback?.({ text: msg });
      return { success: true, text: msg, data: { matches: matches.length } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`SWITCH_TASK error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "switch to the auth task" } },
      {
        name: "{{agent}}",
        content: {
          text: "Switching to auth task...",
          actions: ["SWITCH_TASK"],
        },
      },
    ],
  ],
};

// ============================================================================
// Search Tasks Action
// ============================================================================

export const searchTasksAction: Action = {
  name: "SEARCH_TASKS",
  similes: ["FIND_TASK", "LOOKUP_TASK"],
  description: `Search for tasks by name, description, or content without switching context.

USE THIS ACTION WHEN:
- User says "search tasks", "find task", or "look for task"
- User wants to find tasks matching a query
- User asks "which task" handles something

DO NOT USE WHEN:
- User wants to list all tasks (use LIST_TASKS)
- User wants to switch to a found task (use SWITCH_TASK)
- User wants to create a new task (use CREATE_TASK)

OUTPUT: List of matching tasks with status and progress.`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      text.includes("search task") ||
      text.includes("find task") ||
      text.includes("look for task") ||
      text.includes("which task")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const query = extractTaskQuery(message.content.text ?? "");

      if (!query) {
        const msg = "What would you like to search for?";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const matches = await service.searchTasks(query);

      if (matches.length === 0) {
        const msg = `No tasks found matching: "${query}"`;
        await callback?.({ text: msg });
        return { success: true, text: msg };
      }

      const lines = [`Found ${matches.length} task(s) matching "${query}":\n`];
      for (const task of matches.slice(0, 10)) {
        const m = task.metadata;
        lines.push(
          `- ${getStatusSymbol(m.status)} ${task.name} (${m.status}, ${m.progress}%)`,
        );
      }

      const result = lines.join("\n");
      await callback?.({ text: result });
      return { success: true, text: result, data: { count: matches.length } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`SEARCH_TASKS error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "find tasks about authentication" },
      },
      {
        name: "{{agent}}",
        content: { text: "Searching...", actions: ["SEARCH_TASKS"] },
      },
    ],
  ],
};

// ============================================================================
// Pause Task Action
// ============================================================================

export const pauseTaskAction: Action = {
  name: "PAUSE_TASK",
  similes: ["STOP_TASK", "HALT_TASK"],
  description: `Pause a currently running task to temporarily halt its execution.

USE THIS ACTION WHEN:
- User says "pause task" with optional task identifier
- User wants to temporarily stop a running task
- User needs to interrupt ongoing work

DO NOT USE WHEN:
- User wants to permanently stop a task (use CANCEL_TASK)
- Task is not currently running
- User wants to resume a task (use RESUME_TASK)

BEHAVIOR:
- If no task specified, pauses the current task
- Only works on tasks with "running" status
- Task can be resumed later with RESUME_TASK`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      (text.includes("pause") ||
        text.includes("stop") ||
        text.includes("halt")) &&
      text.includes("task")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const query = extractTaskQuery(message.content.text ?? "");

      // If no query, pause current task
      const task = query
        ? (await service.searchTasks(query))[0]
        : await service.getCurrentTask();

      if (!task) {
        const msg = "No task to pause. Specify a task or select one first.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      if (task.metadata.status !== "running") {
        const msg = `Task "${task.name}" is not running (status: ${task.metadata.status})`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const taskId = task.id;
      if (!taskId) {
        const msg = `Task "${task.name}" has no id and cannot be paused.`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      await service.pauseTask(taskId);
      const msg = `Paused task: ${task.name}`;
      await callback?.({ text: msg });
      return { success: true, text: msg, data: { taskId } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`PAUSE_TASK error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "pause the current task" } },
      {
        name: "{{agent}}",
        content: { text: "Pausing...", actions: ["PAUSE_TASK"] },
      },
    ],
  ],
};

// ============================================================================
// Resume Task Action
// ============================================================================

export const resumeTaskAction: Action = {
  name: "RESUME_TASK",
  similes: ["CONTINUE_TASK", "RESTART_TASK", "RUN_TASK"],
  description: `Resume execution of a paused or pending task.

USE THIS ACTION WHEN:
- User says "resume task", "continue task", or "restart task"
- User wants to continue a paused task
- User wants to start a pending task

DO NOT USE WHEN:
- User wants to pause a task (use PAUSE_TASK)
- User wants to create a new task (use CREATE_TASK)
- Task is already running

BEHAVIOR:
- If no task specified, resumes current task or first pending task
- Updates status to running and starts background execution
- Works on paused or pending tasks`,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    if (!text.includes("task")) return false;

    if (
      text.includes("resume") ||
      text.includes("restart") ||
      text.includes("continue")
    ) {
      return true;
    }

    // Treat "start/run/begin task <name>" as a restart ONLY if it matches an existing task.
    if (
      !(
        text.includes("start") ||
        text.includes("run") ||
        text.includes("begin")
      )
    ) {
      return false;
    }

    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (!service) return false;

    const query = extractTaskQuery(message.content.text ?? "");
    if (!query) return true; // start current / first pending

    const matches = await service.searchTasks(query);
    return matches.length > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const query = extractTaskQuery(message.content.text ?? "");

      let task = query
        ? (await service.searchTasks(query))[0]
        : await service.getCurrentTask();

      // If no current task, get first pending
      if (!task) {
        const pending = await service.getTasksByStatus("pending");
        task = pending[0];
      }

      if (!task) {
        const msg = "No task to resume. Create one first!";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const taskId = task.id ?? "";
      if (!taskId) {
        const msg = "Task has no id and cannot be resumed.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      // Update persisted status immediately, then ensure background execution is running.
      if (task.metadata.status !== "running") {
        await service.resumeTask(taskId);
      }
      service.startTaskExecution(taskId).catch(() => {});

      const msg = `Resumed task: ${task.name}`;
      await callback?.({ text: msg });
      return { success: true, text: msg, data: { taskId } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`RESUME_TASK error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "resume the paused task" } },
      {
        name: "{{agent}}",
        content: { text: "Resuming...", actions: ["RESUME_TASK"] },
      },
    ],
  ],
};

// ============================================================================
// Cancel Task Action
// ============================================================================

export const cancelTaskAction: Action = {
  name: "CANCEL_TASK",
  similes: ["DELETE_TASK", "REMOVE_TASK", "ABORT_TASK"],
  description: `Permanently cancel a task, stopping execution and marking it cancelled.

USE THIS ACTION WHEN:
- User says "cancel task", "delete task", or "remove task"
- User wants to permanently stop and abandon a task
- Task is no longer needed or relevant

DO NOT USE WHEN:
- User wants to temporarily pause (use PAUSE_TASK)
- User wants to resume a task (use RESUME_TASK)
- No task identifier is provided

BEHAVIOR:
- Requires a task identifier (name or search query)
- Marks task as cancelled (record kept for history)
- Cannot be undone - use PAUSE_TASK for temporary stops`,

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    return (
      (text.includes("cancel") ||
        text.includes("delete") ||
        text.includes("remove")) &&
      text.includes("task")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = getTaskService(runtime);
      const query = extractTaskQuery(message.content.text ?? "");

      if (!query) {
        const msg = "Please specify which task to cancel.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const matches = await service.searchTasks(query);
      if (matches.length === 0) {
        const msg = `No task found matching: "${query}"`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const task = matches[0];
      const taskId = task.id;
      if (!taskId) {
        const msg = `Task "${task.name}" has no id and cannot be cancelled.`;
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      await service.cancelTask(taskId);
      const msg = `Cancelled task: ${task.name}`;
      await callback?.({ text: msg });
      return { success: true, text: msg, data: { taskId } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`CANCEL_TASK error: ${error}`);
      await callback?.({ text: `Error: ${error}` });
      return { success: false, text: error };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "cancel the api task" } },
      {
        name: "{{agent}}",
        content: { text: "Cancelling...", actions: ["CANCEL_TASK"] },
      },
    ],
  ],
};

// ============================================================================
// Helpers
// ============================================================================

function extractTaskQuery(text: string): string {
  // Remove action keywords, but avoid stripping letters inside words.
  // Use word boundaries and handle plural "tasks".
  const cleaned = text
    .toLowerCase()
    .replace(
      /\b(switch|select|go|change|search|find|pause|stop|halt|resume|restart|continue|start|run|begin|cancel|delete|remove)\b/g,
      "",
    )
    // Common filler words in natural language queries
    .replace(/\b(about|for|named|called|with)\b/g, "")
    .replace(/\bto\b/g, "")
    .replace(/\b(task|tasks|the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

function getStatusSymbol(status: string): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "paused":
      return "⏸️";
    case "cancelled":
      return "🛑";
    default:
      return "❓";
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
