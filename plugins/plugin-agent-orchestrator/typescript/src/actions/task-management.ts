import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { AgentOrchestratorService } from "../services/agent-orchestrator-service.js";

function getService(runtime: IAgentRuntime): AgentOrchestratorService {
  const svc = runtime.getService("CODE_TASK") as AgentOrchestratorService | null;
  if (!svc) {
    throw new Error("AgentOrchestratorService not available (CODE_TASK)");
  }
  return svc;
}

function extractQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(
      /\b(switch|select|go|change|search|find|pause|stop|halt|resume|restart|continue|start|run|begin|cancel|delete|remove|list|show|view)\b/g,
      "",
    )
    .replace(/\b(about|for|named|called|with|to|my|your|our|this|current)\b/g, "")
    .replace(/\b(task|tasks|the|a|an)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// CREATE_TASK
// ============================================================================

export const createTaskAction: Action = {
  name: "CREATE_TASK",
  similes: ["START_TASK", "SPAWN_TASK", "NEW_TASK", "BEGIN_TASK"],
  description:
    "Create an orchestrated background task to be executed by a selected agent provider.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = message.content.text?.toLowerCase() ?? "";
    const hasExplicit =
      text.includes("create task") || text.includes("new task") || text.includes("start a task");
    const hasIntent =
      text.includes("implement") ||
      text.includes("build") ||
      text.includes("create") ||
      text.includes("develop") ||
      text.includes("refactor") ||
      text.includes("fix") ||
      text.includes("add");
    return hasExplicit || hasIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const raw = message.content.text ?? "";

    const opts = options as { title?: string; description?: string; steps?: string[] } | undefined;
    const name =
      (opts?.title ?? raw.split("\n")[0] ?? "New Task").trim().slice(0, 100) || "New Task";
    const description = (opts?.description ?? raw).trim().slice(0, 4000) || name;

    const roomId = message.roomId;
    const task = await svc.createTask(name, description, roomId);

    const stepLines = Array.isArray(opts?.steps) ? opts?.steps : undefined;
    if (stepLines && stepLines.length > 0) {
      for (const s of stepLines) {
        const step = String(s).trim();
        if (!step) continue;
        await svc.addStep(task.id ?? "", step);
      }
      await svc.appendOutput(
        task.id ?? "",
        `Plan:\n${stepLines.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      );
    }

    const msg = `Created task: ${task.name}\nProvider: ${task.metadata.providerLabel ?? task.metadata.providerId}\nStarting execution…`;
    await callback?.({ content: { text: msg } });

    svc.startTaskExecution(task.id ?? "").catch(() => {});

    return { success: true, text: msg, data: { taskId: task.id ?? "" } };
  },
};

// ============================================================================
// LIST_TASKS
// ============================================================================

export const listTasksAction: Action = {
  name: "LIST_TASKS",
  similes: ["SHOW_TASKS", "GET_TASKS", "TASKS", "VIEW_TASKS"],
  description: "List tasks managed by the orchestrator.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return (
      t.includes("list task") || t.includes("show task") || t === "tasks" || t.includes("my task")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const tasks = await svc.getRecentTasks(20);
    if (tasks.length === 0) {
      const msg = "No tasks.";
      await callback?.({ content: { text: msg } });
      return { success: true, text: msg };
    }
    const lines: string[] = ["Tasks:"];
    const current = svc.getCurrentTaskId();
    for (const t of tasks) {
      const marker = t.id === current ? " (current)" : "";
      lines.push(`- ${t.name} — ${t.metadata.status} ${t.metadata.progress}%${marker}`);
    }
    const msg = lines.join("\n");
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

// ============================================================================
// SWITCH_TASK
// ============================================================================

export const switchTaskAction: Action = {
  name: "SWITCH_TASK",
  similes: ["SELECT_TASK", "SET_TASK", "CHANGE_TASK", "GO_TO_TASK"],
  description: "Switch the current task context to a different task.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return (
      t.includes("switch to task") ||
      t.includes("select task") ||
      (t.includes("task") && t.includes("switch"))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const query = extractQuery(message.content.text ?? "");
    if (!query) {
      const msg = "Please specify which task to switch to (by name or id).";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    const matches = await svc.searchTasks(query);
    const chosen = matches[0];
    if (!chosen?.id) {
      const msg = `No task found matching: "${query}"`;
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    svc.setCurrentTask(chosen.id);
    const msg = `Switched to task: ${chosen.name}`;
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg, data: { taskId: chosen.id } };
  },
};

// ============================================================================
// SEARCH_TASKS
// ============================================================================

export const searchTasksAction: Action = {
  name: "SEARCH_TASKS",
  similes: ["FIND_TASK", "LOOKUP_TASK"],
  description: "Search tasks by query.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return t.includes("search task") || t.includes("find task") || t.includes("look for task");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const opt = options as { query?: string } | undefined;
    const query = (opt?.query ?? extractQuery(message.content.text ?? "")).trim();
    if (!query) {
      const msg = "What would you like to search for?";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    const matches = await svc.searchTasks(query);
    if (matches.length === 0) {
      const msg = `No tasks found matching: "${query}"`;
      await callback?.({ content: { text: msg } });
      return { success: true, text: msg };
    }
    const lines: string[] = [`Found ${matches.length} task(s) matching "${query}":`];
    for (const t of matches.slice(0, 10)) {
      lines.push(`- ${t.name} — ${t.metadata.status} ${t.metadata.progress}%`);
    }
    const msg = lines.join("\n");
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

// ============================================================================
// PAUSE / RESUME / CANCEL
// ============================================================================

export const pauseTaskAction: Action = {
  name: "PAUSE_TASK",
  similes: ["STOP_TASK", "HALT_TASK"],
  description: "Pause a running task.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return (t.includes("pause") || t.includes("stop") || t.includes("halt")) && t.includes("task");
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const query = extractQuery(message.content.text ?? "");
    const task = query ? (await svc.searchTasks(query))[0] : await svc.getCurrentTask();
    if (!task?.id) {
      const msg = "No task to pause.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    await svc.pauseTask(task.id);
    const msg = `Paused task: ${task.name}`;
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

export const resumeTaskAction: Action = {
  name: "RESUME_TASK",
  similes: ["CONTINUE_TASK", "RESTART_TASK", "RUN_TASK"],
  description: "Resume a paused task.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return (
      t.includes("task") &&
      (t.includes("resume") || t.includes("restart") || t.includes("continue"))
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const query = extractQuery(message.content.text ?? "");
    const task = query ? (await svc.searchTasks(query))[0] : await svc.getCurrentTask();
    if (!task?.id) {
      const msg = "No task to resume.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    await svc.resumeTask(task.id);
    svc.startTaskExecution(task.id).catch(() => {});
    const msg = `Resumed task: ${task.name}`;
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg };
  },
};

export const cancelTaskAction: Action = {
  name: "CANCEL_TASK",
  similes: ["DELETE_TASK", "REMOVE_TASK", "ABORT_TASK"],
  description: "Cancel a task.",
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const t = message.content.text?.toLowerCase() ?? "";
    return (
      (t.includes("cancel") || t.includes("delete") || t.includes("remove")) && t.includes("task")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = getService(runtime);
    const query = extractQuery(message.content.text ?? "");
    const task = query ? (await svc.searchTasks(query))[0] : await svc.getCurrentTask();
    if (!task?.id) {
      const msg = "No task to cancel.";
      await callback?.({ content: { text: msg } });
      return { success: false, text: msg };
    }
    await svc.cancelTask(task.id);
    const msg = `Cancelled task: ${task.name}`;
    await callback?.({ content: { text: msg } });
    return { success: true, text: msg };
  },
};
