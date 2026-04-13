import type { AgentRuntime } from "@elizaos/core";
import type { AgentOrchestratorService as CodeTaskService } from "@elizaos/plugin-agent-orchestrator";
import { type Component, Editor, type Focusable, type TUI } from "@elizaos/tui";
import chalk from "chalk";
import { useStore } from "../lib/store.js";
import type {
  SubAgentType,
  TaskStatus,
  TaskTraceEvent,
  TaskUserStatus,
} from "../types.js";

const SUB_AGENT_TYPES: SubAgentType[] = [
  "eliza",
  "claude-code",
  "codex",
  "opencode",
  "sweagent",
  "elizaos-native",
];

interface TaskPaneProps {
  runtime: AgentRuntime;
  tui: TUI;
}

function getStatusIcon(status: TaskStatus): string {
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

function getStatusColor(status: TaskStatus): (text: string) => string {
  switch (status) {
    case "pending":
      return chalk.gray;
    case "running":
      return chalk.yellow;
    case "completed":
      return chalk.green;
    case "failed":
      return chalk.red;
    case "paused":
      return chalk.blue;
    case "cancelled":
      return chalk.red;
    default:
      return chalk.white;
  }
}

function getTaskUserStatus(
  userStatus: TaskUserStatus | undefined,
): TaskUserStatus {
  return userStatus ?? "open";
}

function reportTaskServiceError(
  taskService: CodeTaskService,
  taskId: string,
  action: string,
  err: Error,
): void {
  const msg = err.message;
  const line = `UI error (${action}): ${msg}`;
  taskService.appendOutput(taskId, line).catch(() => {});
  process.stderr.write(`[TaskPane] ${line}\n`);
}

function formatTraceLines(events: TaskTraceEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const head = `#${event.seq}`;
    switch (event.kind) {
      case "status":
        lines.push(
          `${head} ⏸️ ${event.status}${event.message ? ` — ${event.message}` : ""}`,
        );
        break;
      case "note": {
        const icon =
          event.level === "error"
            ? "❌"
            : event.level === "warning"
              ? "⚠️"
              : "ℹ️";
        lines.push(`${head} ${icon} ${event.message}`);
        break;
      }
      case "llm":
        lines.push(
          `${head} 🤖 LLM iter ${event.iteration} (${event.modelType})`,
        );
        lines.push(`  ${event.responsePreview}`);
        break;
      case "tool_call":
        lines.push(`${head} 🔧 TOOL: ${event.name}`);
        break;
      case "tool_result":
        lines.push(
          `${head} 🔧 RESULT: ${event.name} ${event.success ? "✓" : "✗"}`,
        );
        lines.push(`  ${event.outputPreview}`);
        break;
    }
  }
  return lines;
}

export class TaskPane implements Component, Focusable {
  private props: TaskPaneProps;
  private width = 40;
  private focused = false;
  private selectedIndex = 0;
  private detailView: "output" | "trace" = "output";
  private detailScrollOffset = 0;
  private editMode = false;
  private isRenaming = false;
  private renameEditor: Editor | null = null;
  private confirm: { type: "cancel" | "delete"; taskId: string } | null = null;

  constructor(props: TaskPaneProps) {
    this.props = props;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (!focused) {
      this.editMode = false;
      this.isRenaming = false;
      this.confirm = null;
    }
  }

  isFocused(): boolean {
    return this.focused;
  }

  private getTaskService(): CodeTaskService | null {
    return this.props.runtime.getService("CODE_TASK") as CodeTaskService | null;
  }

  handleInput(char: string): void {
    if (!this.focused) return;

    const state = useStore.getState();
    const tasks = state.tasks;
    const currentTaskId = state.currentTaskId;
    const showFinished = state.showFinishedTasks;

    const visibleTasks = showFinished
      ? tasks
      : tasks.filter(
          (t) =>
            getTaskUserStatus(t.metadata?.userStatus) !== "done" ||
            t.id === currentTaskId,
        );

    const currentTask = tasks.find((t) => t.id === currentTaskId);
    const taskService = this.getTaskService();

    // Handle rename mode
    if (this.isRenaming && this.renameEditor) {
      if (char === "\x1b") {
        // Escape
        this.isRenaming = false;
        this.renameEditor = null;
        this.props.tui.requestRender();
        return;
      }
      if (char === "\r") {
        // Enter
        const next = this.renameEditor.getText().trim();
        const taskId = currentTask?.id ?? null;
        if (next.length > 0 && taskId && taskService) {
          taskService.renameTask(taskId, next).catch((err: Error) => {
            reportTaskServiceError(taskService, taskId, "renameTask", err);
          });
        }
        this.isRenaming = false;
        this.renameEditor = null;
        this.props.tui.requestRender();
        return;
      }
      this.renameEditor.handleInput(char);
      this.props.tui.requestRender();
      return;
    }

    // Handle confirmation dialog
    if (this.confirm) {
      if (char === "y" || char === "Y") {
        if (taskService) {
          if (this.confirm.type === "cancel") {
            taskService.cancelTask(this.confirm.taskId).catch((err: Error) => {
              reportTaskServiceError(
                taskService,
                this.confirm?.taskId,
                "cancelTask",
                err,
              );
            });
          } else {
            taskService.deleteTask(this.confirm.taskId).catch((err: Error) => {
              reportTaskServiceError(
                taskService,
                this.confirm?.taskId,
                "deleteTask",
                err,
              );
            });
          }
        }
        this.confirm = null;
        this.props.tui.requestRender();
        return;
      }
      if (char === "n" || char === "N" || char === "\x1b") {
        this.confirm = null;
        this.props.tui.requestRender();
        return;
      }
      return;
    }

    // Navigation
    if (char === "\x1b[A") {
      // Up arrow
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.props.tui.requestRender();
      return;
    }
    if (char === "\x1b[B") {
      // Down arrow
      this.selectedIndex = Math.min(
        visibleTasks.length - 1,
        this.selectedIndex + 1,
      );
      this.props.tui.requestRender();
      return;
    }

    // Select task with Enter
    if (char === "\r" && visibleTasks.length > 0) {
      const safeIndex = Math.min(
        Math.max(0, this.selectedIndex),
        Math.max(0, visibleTasks.length - 1),
      );
      const id = visibleTasks[safeIndex]?.id ?? null;
      if (id) {
        state.setCurrentTaskId(id);
        taskService?.setCurrentTask(id);
        this.detailScrollOffset = 0;
        this.props.tui.requestRender();
      }
      return;
    }

    // Ctrl+Up/Down for detail scroll
    if (char === "\x1b[1;5A") {
      this.detailScrollOffset++;
      this.props.tui.requestRender();
      return;
    }
    if (char === "\x1b[1;5B") {
      this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 1);
      this.props.tui.requestRender();
      return;
    }

    // Toggle finished tasks
    if (char === "f") {
      state.toggleShowFinishedTasks();
      this.props.tui.requestRender();
      return;
    }

    // Toggle edit mode
    if (char === "e") {
      this.editMode = !this.editMode;
      this.props.tui.requestRender();
      return;
    }

    // Toggle trace view
    if (char === "t") {
      this.detailView = this.detailView === "output" ? "trace" : "output";
      this.detailScrollOffset = 0;
      this.props.tui.requestRender();
      return;
    }

    // Mark/unmark as done
    if (char === "d" && taskService && currentTask) {
      const taskId = currentTask.id;
      if (taskId) {
        const currentUserStatus = getTaskUserStatus(
          currentTask.metadata?.userStatus,
        );
        const nextStatus: TaskUserStatus =
          currentUserStatus === "done" ? "open" : "done";
        taskService.setUserStatus(taskId, nextStatus).catch((err: Error) => {
          reportTaskServiceError(taskService, taskId, "setUserStatus", err);
        });
        this.props.tui.requestRender();
      }
      return;
    }

    // Edit mode commands
    if (!this.editMode || !taskService || !currentTask) return;
    const taskId = currentTask.id;
    if (!taskId) return;

    // Cycle sub-agent
    if (char === "a") {
      const rawType = currentTask.metadata?.subAgentType;
      const current = SUB_AGENT_TYPES.includes(rawType as SubAgentType)
        ? (rawType as SubAgentType)
        : "eliza";
      const idx = Math.max(0, SUB_AGENT_TYPES.indexOf(current));
      const next = SUB_AGENT_TYPES[(idx + 1) % SUB_AGENT_TYPES.length];
      taskService.setTaskSubAgentType(taskId, next).catch((err: Error) => {
        reportTaskServiceError(taskService, taskId, "setTaskSubAgentType", err);
      });
      this.props.tui.requestRender();
      return;
    }

    // Rename
    if (char === "r") {
      this.renameDraft = currentTask.name;
      this.renameEditor = new Editor({
        width: Math.max(1, this.width - 12),
        maxHeight: 1,
        initialText: currentTask.name,
      });
      this.renameEditor.setFocused(true);
      this.isRenaming = true;
      this.props.tui.requestRender();
      return;
    }

    // Cancel (with confirmation)
    if (char === "c") {
      this.confirm = { type: "cancel", taskId };
      this.props.tui.requestRender();
      return;
    }

    // Delete (with confirmation)
    if (char === "x") {
      this.confirm = { type: "delete", taskId };
      this.props.tui.requestRender();
      return;
    }

    // Pause/resume
    if (char === "p") {
      const status = currentTask.metadata?.status ?? "pending";
      if (status === "running") {
        taskService.pauseTask(taskId).catch((err: Error) => {
          reportTaskServiceError(taskService, taskId, "pauseTask", err);
        });
      } else if (status === "paused" || status === "pending") {
        taskService.resumeTask(taskId).then(
          () =>
            taskService.startTaskExecution(taskId).catch((err: Error) => {
              reportTaskServiceError(
                taskService,
                taskId,
                "startTaskExecution",
                err,
              );
            }),
          (err: Error) => {
            reportTaskServiceError(taskService, taskId, "resumeTask", err);
          },
        );
      }
      this.props.tui.requestRender();
    }
  }

  render(width: number, height: number): string[] {
    this.width = width;
    this.height = height;

    const state = useStore.getState();
    const tasks = state.tasks;
    const currentTaskId = state.currentTaskId;
    const showFinished = state.showFinishedTasks;

    const visibleTasks = showFinished
      ? tasks
      : tasks.filter(
          (t) =>
            getTaskUserStatus(t.metadata?.userStatus) !== "done" ||
            t.id === currentTaskId,
        );

    const currentTask = tasks.find((t) => t.id === currentTaskId);
    const innerWidth = Math.max(1, width - 2);

    const output: string[] = [];

    // Header
    const headerColor = this.focused ? chalk.bold.cyan : chalk.white;
    const editIndicator = this.editMode ? " [edit]" : "";
    const header = `${headerColor(`Tasks${editIndicator}`)} ${chalk.dim(`(${visibleTasks.length}/${tasks.length})`)}${showFinished ? chalk.dim(" (all)") : ""}`;
    output.push(` ${header}`);

    // Task list
    const taskListHeight = Math.min(8, Math.max(3, height - 12));
    const maxTaskNameChars = Math.max(12, Math.min(60, width - 16));

    if (visibleTasks.length === 0) {
      output.push(
        ` ${chalk.dim.italic(tasks.length === 0 ? "No tasks." : "No open tasks.")}`,
      );
      for (let i = 1; i < taskListHeight; i++) {
        output.push("");
      }
    } else {
      const validSelectedIndex = Math.max(
        0,
        Math.min(this.selectedIndex, visibleTasks.length - 1),
      );

      for (let i = 0; i < Math.min(visibleTasks.length, taskListHeight); i++) {
        const task = visibleTasks[i];
        const isSelected = i === validSelectedIndex && this.focused;
        const isCurrent = task.id === currentTaskId;
        const status = task.metadata?.status ?? "pending";
        const progress = task.metadata?.progress ?? 0;
        const userStatus = getTaskUserStatus(task.metadata?.userStatus);

        const displayName = task.name.substring(0, maxTaskNameChars);
        const clipped = task.name.length > maxTaskNameChars ? "..." : "";

        let lineText = `${isSelected ? "▶ " : "  "}${getStatusIcon(status)} ${displayName}${clipped}`;
        lineText += chalk.dim(` (${progress}%)`);
        if (userStatus === "done") lineText += chalk.dim(" ✓");

        if (isSelected) {
          lineText = chalk.cyan.inverse(lineText);
        } else if (isCurrent) {
          lineText = chalk.yellow.bold(lineText);
        }

        output.push(` ${lineText}`);
      }

      // Fill remaining space
      const remaining =
        taskListHeight - Math.min(visibleTasks.length, taskListHeight);
      for (let i = 0; i < remaining; i++) {
        output.push("");
      }
    }

    // Current task details
    if (currentTask) {
      const progressBarWidth = Math.max(8, Math.min(20, width - 22));
      const maxOutputLines = Math.max(6, height - 12);
      const maxOutputChars = Math.max(12, width - 4);

      const outputLines = currentTask.metadata?.output ?? [];
      const traceLines = formatTraceLines(currentTask.metadata?.trace ?? []);
      const detailLines =
        this.detailView === "output" ? outputLines : traceLines;

      // Border
      const borderColor = this.focused ? chalk.cyan : chalk.gray;
      output.push(borderColor(`┌${"─".repeat(innerWidth)}┐`));

      // Task header
      const statusColor = getStatusColor(
        currentTask.metadata?.status ?? "pending",
      );
      const taskHeader = `${getStatusIcon(currentTask.metadata?.status ?? "pending")} ${currentTask.name}`;
      output.push(
        `${borderColor("│")} ${statusColor(chalk.bold(taskHeader)).padEnd(innerWidth - 1)}${borderColor("│")}`,
      );

      // Progress bar
      const progress = currentTask.metadata?.progress ?? 0;
      const filled = Math.round((progress / 100) * progressBarWidth);
      const empty = progressBarWidth - filled;
      const progressBar =
        chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty));
      output.push(
        `${borderColor("│")} ${chalk.dim("Progress: ")}${progressBar}${` ${progress}%`.padEnd(innerWidth - progressBarWidth - 12)}${borderColor("│")}`,
      );

      // Sub-agent
      output.push(
        `${borderColor("│")} ${chalk.dim(`Sub-agent: ${currentTask.metadata?.subAgentType ?? "eliza"}`).padEnd(innerWidth - 1)}${borderColor("│")}`,
      );

      // Detail view header
      const detailHeader = this.detailView === "output" ? "Output" : "Trace";
      const liveIndicator =
        currentTask.metadata?.status === "running" ? " (live)" : "";
      output.push(
        `${borderColor("│")} ${chalk.dim.bold(`${detailHeader}${liveIndicator}`).padEnd(innerWidth - 1)}${borderColor("│")}`,
      );

      // Detail lines
      const detailStart = Math.max(
        0,
        detailLines.length - maxOutputLines - this.detailScrollOffset,
      );
      const detailEnd = detailLines.length - this.detailScrollOffset;
      const visibleDetail = detailLines.slice(detailStart, detailEnd);

      if (visibleDetail.length === 0) {
        output.push(
          `${borderColor("│")} ${chalk.dim.italic(this.detailView === "output" ? "No output yet." : "No trace yet.").padEnd(innerWidth - 1)}${borderColor("│")}`,
        );
      } else {
        for (const line of visibleDetail.slice(0, maxOutputLines)) {
          const isError =
            line.startsWith("❌") ||
            line.startsWith("⚠️") ||
            line.startsWith("Error:");
          const isSuccess = line.startsWith("🎉") || line.startsWith("✅");
          const isTool = line.startsWith("🔧") || line.startsWith("[");
          const isAgent =
            line.startsWith("🤖") ||
            line.startsWith("🧠") ||
            line.startsWith("#");

          let color = chalk.dim;
          if (isError) color = chalk.red;
          else if (isSuccess) color = chalk.green;
          else if (isTool) color = chalk.yellow;
          else if (isAgent) color = chalk.cyan;

          const clipped =
            line.length > maxOutputChars
              ? `${line.slice(0, Math.max(0, maxOutputChars - 1))}…`
              : line;
          output.push(
            `${borderColor("│")} ${color(clipped).padEnd(innerWidth - 1)}${borderColor("│")}`,
          );
        }
      }

      if (this.detailScrollOffset > 0) {
        output.push(
          `${borderColor("│")} ${chalk.dim(`[↓ ${this.detailScrollOffset} newer lines]`).padEnd(innerWidth - 1)}${borderColor("│")}`,
        );
      }

      // Error display
      if (currentTask.metadata?.error) {
        output.push(
          `${borderColor("│")} ${chalk.red.bold("Error: ")}${chalk.red(currentTask.metadata.error.substring(0, innerWidth - 10)).padEnd(innerWidth - 8)}${borderColor("│")}`,
        );
      }

      output.push(borderColor(`└${"─".repeat(innerWidth)}┘`));
    }

    // Rename input
    if (this.isRenaming && this.renameEditor) {
      const borderColor = chalk.cyan;
      output.push(borderColor(`┌${"─".repeat(innerWidth)}┐`));
      const editorLines = this.renameEditor.render(innerWidth - 2, 1);
      output.push(
        `${borderColor("│")} ${chalk.dim("Rename: ")}${(editorLines[0] || "").padEnd(innerWidth - 10)}${borderColor("│")}`,
      );
      output.push(borderColor(`└${"─".repeat(innerWidth)}┘`));
    }

    // Help text
    const helpText = !this.focused
      ? "Tab: focus tasks"
      : this.confirm
        ? `Confirm ${this.confirm.type}? (y/n)`
        : this.editMode
          ? "Edit: a agent • r rename • p pause/resume • c cancel • x delete • t trace • e exit • f finished"
          : "↑↓ select • Enter switch • e edit • t trace • d done/open • f finished";
    output.push(chalk.dim(helpText));

    return output;
  }
}
