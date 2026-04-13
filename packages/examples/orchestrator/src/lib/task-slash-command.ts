import type { AgentOrchestratorService as CodeTaskService } from "@elizaos/plugin-agent-orchestrator";
import type { Message, SubAgentType, TaskPaneVisibility } from "../types.js";

export interface TaskSlashCommandDeps {
  service: CodeTaskService | null;
  currentRoomId: string;
  addMessage: (roomId: string, role: Message["role"], content: string) => void;
  setCurrentTaskId: (taskId: string | null) => void;
  setTaskPaneVisibility: (visibility: TaskPaneVisibility) => void;
  taskPaneVisibility: TaskPaneVisibility;
  showTaskPane: boolean;
}

export async function handleTaskSlashCommand(
  args: string,
  deps: TaskSlashCommandDeps,
): Promise<boolean> {
  const {
    service,
    currentRoomId,
    addMessage,
    setCurrentTaskId,
    setTaskPaneVisibility,
    taskPaneVisibility,
    showTaskPane,
  } = deps;

  if (!args.trim()) {
    addMessage(
      currentRoomId,
      "system",
      `Task commands:
/task list
/task switch <name|id>
/task current
/task agent <type> [name|id]
/task pause [name|id]
/task resume [name|id]
/task restart [name|id]
/task cancel <name|id>
/task delete <name|id>
/task done [name|id]
/task open [name|id]
/task pane show|hide|auto|toggle

Aliases:
/tasks (list)
/tasks show|hide|auto|toggle`,
    );
    return true;
  }

  const [subCmd, ...subArgs] = args.split(" ");
  const subArg = subArgs.join(" ").trim();

  switch ((subCmd ?? "").toLowerCase()) {
    case "list":
    case "ls": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const tasks = await service.getTasks();
      if (tasks.length === 0) {
        addMessage(currentRoomId, "system", "No tasks.");
        return true;
      }
      const taskList = tasks
        .map(
          (t: {
            id: string;
            name: string;
            metadata?: {
              status?: string;
              progress?: number;
              userStatus?: string;
            };
          }) => {
            const isCurrent = t.id === service.getCurrentTaskId();
            const status = t.metadata?.status ?? "pending";
            const progress = t.metadata?.progress ?? 0;
            const userStatus = t.metadata?.userStatus ?? "open";
            const marker = isCurrent ? "→ " : "  ";
            const doneMark = userStatus === "done" ? " ✓" : "";
            return `${marker}[${status}] ${t.name} (${progress}%)${doneMark}`;
          },
        )
        .join("\n");
      addMessage(currentRoomId, "system", `Tasks:\n${taskList}`);
      return true;
    }

    case "switch":
    case "select": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      if (!subArg) {
        addMessage(currentRoomId, "system", "Usage: /task switch <name or id>");
        return true;
      }
      const matches = await service.searchTasks(subArg);
      if (matches.length === 0) {
        addMessage(
          currentRoomId,
          "system",
          `No task found matching: "${subArg}"`,
        );
        return true;
      }
      const task = matches[0];
      service.setCurrentTask(task.id ?? null);
      setCurrentTaskId(task.id ?? null);
      addMessage(
        currentRoomId,
        "system",
        `Switched to: ${task.name} (${task.metadata?.status}, ${task.metadata?.progress}%)`,
      );
      return true;
    }

    case "current": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const current = await service.getCurrentTask();
      if (!current) {
        addMessage(
          currentRoomId,
          "system",
          "No task selected. Use /task switch <name>",
        );
        return true;
      }
      const m = current.metadata;
      let details = `Task: ${current.name}\n`;
      details += `Status: ${m?.status ?? "unknown"}\n`;
      details += `Progress: ${m?.progress ?? 0}%\n`;
      details += `User: ${m?.userStatus ?? "open"}\n`;
      if (current.description) {
        details += `Description: ${current.description.substring(0, 100)}\n`;
      }
      const created = m?.filesCreated ?? m?.result?.filesCreated ?? [];
      const modified = m?.filesModified ?? m?.result?.filesModified ?? [];
      if (created.length > 0 || modified.length > 0) {
        details += "\nFiles:\n";
        if (created.length > 0) details += `  + ${created.join(", ")}\n`;
        if (modified.length > 0) details += `  ~ ${modified.join(", ")}\n`;
      }
      if (m?.output && m.output.length > 0) {
        const recentOutput = m.output.slice(-5).join("\n");
        details += `\nRecent output:\n${recentOutput}`;
      }
      addMessage(currentRoomId, "system", details);
      return true;
    }

    case "agent":
    case "subagent":
    case "worker": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }

      if (!subArg) {
        addMessage(
          currentRoomId,
          "system",
          `Usage: /task agent <type> [name|id]\n\nTypes:\n- eliza\n- claude-code\n- codex\n- opencode\n- sweagent\n- elizaos-native`,
        );
        return true;
      }

      const [typeRaw, ...rest] = subArg.split(" ");
      const target = rest.join(" ").trim();

      const normalizedType = normalizeSubAgentType(typeRaw);
      if (!normalizedType) {
        addMessage(
          currentRoomId,
          "system",
          `Unknown agent type: "${typeRaw}". Try: eliza, claude-code, codex, opencode, sweagent, elizaos-native`,
        );
        return true;
      }

      const taskId = target
        ? (await service.searchTasks(target))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task selected");
        return true;
      }

      await service.setTaskSubAgentType(taskId, normalizedType);
      const task = await service.getTask(taskId);
      addMessage(
        currentRoomId,
        "system",
        `Set sub-agent for "${task?.name ?? taskId}" to ${normalizedType}`,
      );
      return true;
    }

    case "pause": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const taskId = subArg
        ? (await service.searchTasks(subArg))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task to pause");
        return true;
      }
      await service.pauseTask(taskId);
      addMessage(currentRoomId, "system", "Task paused");
      return true;
    }

    case "resume": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const taskId = subArg
        ? (await service.searchTasks(subArg))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task to resume");
        return true;
      }
      await service.resumeTask(taskId);
      service.startTaskExecution(taskId).then(
        () => {},
        (err: Error) => {
          const msg = err.message;
          addMessage(currentRoomId, "system", `Failed to start task: ${msg}`);
        },
      );
      addMessage(currentRoomId, "system", "Task resumed");
      return true;
    }

    case "restart":
    case "start": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const taskId = subArg
        ? (await service.searchTasks(subArg))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task to restart");
        return true;
      }
      // Ensure the runner is active (idempotent if already running in this process).
      service.startTaskExecution(taskId).then(
        () => {},
        (err: Error) => {
          const msg = err.message;
          addMessage(currentRoomId, "system", `Failed to start task: ${msg}`);
        },
      );
      const task = await service.getTask(taskId);
      addMessage(
        currentRoomId,
        "system",
        `Restarting: ${task?.name ?? taskId}`,
      );
      return true;
    }

    case "cancel": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      if (!subArg) {
        addMessage(currentRoomId, "system", "Usage: /task cancel <name>");
        return true;
      }
      const matches = await service.searchTasks(subArg);
      if (matches.length === 0) {
        addMessage(currentRoomId, "system", `No task found: "${subArg}"`);
        return true;
      }
      await service.cancelTask(matches[0].id ?? "");
      addMessage(currentRoomId, "system", `Cancelled: ${matches[0].name}`);
      return true;
    }

    case "delete": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      if (!subArg) {
        addMessage(currentRoomId, "system", "Usage: /task delete <name>");
        return true;
      }
      const matches = await service.searchTasks(subArg);
      if (matches.length === 0) {
        addMessage(currentRoomId, "system", `No task found: "${subArg}"`);
        return true;
      }
      await service.deleteTask(matches[0].id ?? "");
      addMessage(currentRoomId, "system", `Deleted: ${matches[0].name}`);
      return true;
    }

    case "done": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const taskId = subArg
        ? (await service.searchTasks(subArg))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task to mark done");
        return true;
      }
      await service.setUserStatus(taskId, "done");
      const task = await service.getTask(taskId);
      addMessage(
        currentRoomId,
        "system",
        `Marked done: ${task?.name ?? taskId}`,
      );
      return true;
    }

    case "open": {
      if (!service) {
        addMessage(currentRoomId, "system", "Task service not available");
        return true;
      }
      const taskId = subArg
        ? (await service.searchTasks(subArg))[0]?.id
        : service.getCurrentTaskId();
      if (!taskId) {
        addMessage(currentRoomId, "system", "No task to re-open");
        return true;
      }
      await service.setUserStatus(taskId, "open");
      const task = await service.getTask(taskId);
      addMessage(currentRoomId, "system", `Re-opened: ${task?.name ?? taskId}`);
      return true;
    }

    case "pane": {
      const mode = subArg.trim().toLowerCase();
      if (!mode) {
        addMessage(
          currentRoomId,
          "system",
          "Usage: /task pane show|hide|auto|toggle",
        );
        return true;
      }

      if (mode === "show") {
        setTaskPaneVisibility("shown");
        return true;
      }
      if (mode === "hide") {
        setTaskPaneVisibility("hidden");
        return true;
      }
      if (mode === "auto") {
        setTaskPaneVisibility("auto");
        return true;
      }
      if (mode === "toggle") {
        const next =
          taskPaneVisibility === "hidden"
            ? "shown"
            : taskPaneVisibility === "shown"
              ? "hidden"
              : showTaskPane
                ? "hidden"
                : "shown";
        setTaskPaneVisibility(next);
        return true;
      }

      addMessage(
        currentRoomId,
        "system",
        `Unknown: /task pane ${subArg}. Try: /task pane show|hide|auto|toggle`,
      );
      return true;
    }

    default:
      addMessage(
        currentRoomId,
        "system",
        `Unknown task command: ${subCmd}. Try /task for help.`,
      );
      return true;
  }
}

function normalizeSubAgentType(input: string | undefined): SubAgentType | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;

  if (raw === "eliza") return "eliza";
  if (raw === "claude" || raw === "claude-code" || raw === "claudecode")
    return "claude-code";
  if (raw === "codex") return "codex";
  if (raw === "opencode" || raw === "open-code" || raw === "open_code")
    return "opencode";
  if (raw === "sweagent" || raw === "swe-agent" || raw === "swe_agent")
    return "sweagent";
  if (
    raw === "elizaos-native" ||
    raw === "eliza-native" ||
    raw === "native" ||
    raw === "elizaosnative"
  )
    return "elizaos-native";

  return null;
}
