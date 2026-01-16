import type { AgentOrchestratorService as CodeTaskService } from "@elizaos/plugin-agent-orchestrator";
import { Box, type Key, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import React, { useState } from "react";
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

function reportTaskServiceError(
  taskService: CodeTaskService,
  taskId: string,
  action: string,
  err: Error,
): void {
  const msg = err.message;
  const line = `UI error (${action}): ${msg}`;
  taskService.appendOutput(taskId, line).then(
    () => {},
    (appendErr: Error) => {
      const appendMsg = appendErr.message;
      process.stderr.write(
        `[TaskPane] Failed to append error output: ${appendMsg}\n`,
      );
    },
  );
  process.stderr.write(`[TaskPane] ${line}\n`);
}

interface TaskPaneProps {
  isFocused: boolean;
  paneHeight: number;
  paneWidth: number;
  taskService: CodeTaskService | null;
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

function getStatusColor(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "gray";
    case "running":
      return "yellow";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "paused":
      return "blue";
    case "cancelled":
      return "red";
    default:
      return "white";
  }
}

function getTaskUserStatus(
  userStatus: TaskUserStatus | undefined,
): TaskUserStatus {
  return userStatus ?? "open";
}

export function TaskPane({
  isFocused,
  paneHeight,
  paneWidth,
  taskService,
}: TaskPaneProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailView, setDetailView] = useState<"output" | "trace">("output");
  const [detailScrollOffset, setDetailScrollOffset] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirm, setConfirm] = useState<{
    type: "cancel" | "delete";
    taskId: string;
  } | null>(null);

  const maxOutputLines = Math.max(6, paneHeight - 12);
  const maxOutputChars = Math.max(12, paneWidth - 4);

  const tasks = useStore((state) => state.tasks);
  const currentTaskId = useStore((state) => state.currentTaskId);
  const setCurrentTaskId = useStore((state) => state.setCurrentTaskId);
  const showFinishedTasks = useStore((state) => state.showFinishedTasks);
  const toggleShowFinishedTasks = useStore(
    (state) => state.toggleShowFinishedTasks,
  );

  // View filtering should not implicitly change selection. If the current task is finished,
  // keep it visible even when "finished tasks" are hidden so the UI stays stable.
  const visibleTasks = showFinishedTasks
    ? tasks
    : tasks.filter(
        (t) =>
          getTaskUserStatus(t.metadata?.userStatus) !== "done" ||
          t.id === currentTaskId,
      );

  const currentTask = tasks.find((t) => t.id === currentTaskId);

  // Auto-scroll to bottom when task is running
  React.useEffect(() => {
    if (currentTask?.metadata?.status === "running") {
      setDetailScrollOffset(0);
    }
  }, [currentTask?.metadata?.status]);

  const outputLines = currentTask?.metadata?.output ?? [];
  const traceLines = formatTraceLines(currentTask?.metadata?.trace ?? []);
  const detailLines = detailView === "output" ? outputLines : traceLines;

  // Handle keyboard navigation
  useInput(
    (char: string, key: Key) => {
      if (!isFocused) return;

      // Renaming: let TextInput handle most keystrokes.
      if (isRenaming) {
        if (key.escape) {
          setIsRenaming(false);
          setRenameDraft("");
          return;
        }
        if (key.return) {
          const next = renameDraft.trim();
          if (next.length > 0 && currentTask?.id && taskService) {
            // TODO: renameTask is not implemented in AgentOrchestratorService
            // For now, just close the rename dialog
            console.warn("Task renaming not yet implemented");
          }
          setIsRenaming(false);
          setRenameDraft("");
          return;
        }
        return;
      }

      // Confirm destructive action
      if (confirm) {
        if (char === "y" || char === "Y") {
          if (taskService) {
            if (confirm.type === "cancel") {
              taskService.cancelTask(confirm.taskId).catch((err: Error) => {
                reportTaskServiceError(
                  taskService,
                  confirm.taskId,
                  "cancelTask",
                  err,
                );
              });
            } else {
              taskService.deleteTask(confirm.taskId).catch((err: Error) => {
                reportTaskServiceError(
                  taskService,
                  confirm.taskId,
                  "deleteTask",
                  err,
                );
              });
            }
          }
          setConfirm(null);
          return;
        }
        if (char === "n" || char === "N" || key.escape) {
          setConfirm(null);
          return;
        }
        return;
      }

      // Navigate task list
      if (key.upArrow && !key.ctrl) {
        setSelectedIndex((prev) => {
          if (visibleTasks.length === 0) return 0;
          return Math.max(0, prev - 1);
        });
      }
      if (key.downArrow && !key.ctrl) {
        setSelectedIndex((prev) => {
          if (visibleTasks.length === 0) return 0;
          return Math.min(visibleTasks.length - 1, prev + 1);
        });
      }

      // Select task with Enter
      if (key.return && visibleTasks.length > 0) {
        const safeIndex = Math.min(
          Math.max(0, selectedIndex),
          Math.max(0, visibleTasks.length - 1),
        );
        const id = visibleTasks[safeIndex]?.id ?? null;
        if (!id) return;
        setCurrentTaskId(id);
        taskService?.setCurrentTask(id);
        setDetailScrollOffset(0);
      }

      // Scroll detail view
      if (key.upArrow && key.ctrl) {
        const totalLen = detailLines.length;
        setDetailScrollOffset((prev) =>
          Math.min(prev + 1, Math.max(0, totalLen - maxOutputLines)),
        );
      }
      if (key.downArrow && key.ctrl) {
        setDetailScrollOffset((prev) => Math.max(0, prev - 1));
      }

      // Toggle showing finished tasks
      if (char === "f" && !key.ctrl && !key.meta) {
        toggleShowFinishedTasks();
      }

      // Toggle edit mode
      if (char === "e" && !key.ctrl && !key.meta) {
        setEditMode((prev) => !prev);
      }

      // Toggle trace view
      if (char === "t" && !key.ctrl && !key.meta) {
        setDetailView((prev) => (prev === "output" ? "trace" : "output"));
        setDetailScrollOffset(0);
      }

      // Mark/unmark current task as finished (user-controlled)
      if (
        char === "d" &&
        !key.ctrl &&
        !key.meta &&
        currentTask?.id &&
        taskService
      ) {
        const currentUserStatus = getTaskUserStatus(
          currentTask.metadata?.userStatus,
        );
        const nextStatus: TaskUserStatus =
          currentUserStatus === "done" ? "open" : "done";
        const taskId = currentTask.id;
        if (taskId) {
          taskService.setUserStatus(taskId, nextStatus).catch((err: Error) => {
            reportTaskServiceError(taskService, taskId, "setUserStatus", err);
          });
        }
      }

      // Edit mode commands
      if (!editMode) return;
      if (!currentTask?.id || !taskService) return;

      // Cycle sub-agent
      if (char === "a" && !key.ctrl && !key.meta) {
        const current = currentTask.metadata?.subAgentType ?? "eliza";
        const idx = Math.max(0, SUB_AGENT_TYPES.indexOf(current));
        const next = SUB_AGENT_TYPES[(idx + 1) % SUB_AGENT_TYPES.length];
        const taskIdForSubAgent = currentTask.id;
        if (taskIdForSubAgent) {
          taskService
            .setTaskSubAgentType(taskIdForSubAgent, next)
            .catch((err: Error) => {
              reportTaskServiceError(
                taskService,
                taskIdForSubAgent,
                "setTaskSubAgentType",
                err,
              );
            });
        }
        return;
      }

      // Rename
      if (char === "r" && !key.ctrl && !key.meta) {
        setRenameDraft(currentTask.name);
        setIsRenaming(true);
        return;
      }

      // Cancel (confirm)
      if (char === "c" && !key.ctrl && !key.meta) {
        setConfirm({ type: "cancel", taskId: currentTask.id });
        return;
      }

      // Delete (confirm)
      if (char === "x" && !key.ctrl && !key.meta) {
        setConfirm({ type: "delete", taskId: currentTask.id });
        return;
      }

      // Pause/resume
      if (char === "p" && !key.ctrl && !key.meta) {
        const status = currentTask.metadata?.status ?? "pending";
        const taskId = currentTask.id;
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
        return;
      }
    },
    { isActive: isFocused },
  );

  const validSelectedIndex = Math.max(
    0,
    Math.min(selectedIndex, Math.max(0, visibleTasks.length - 1)),
  );

  const detailStart = Math.max(
    0,
    detailLines.length - maxOutputLines - detailScrollOffset,
  );
  const detailEnd = detailLines.length - detailScrollOffset;
  const visibleDetail = detailLines.slice(detailStart, detailEnd);

  const taskListHeight = Math.min(8, Math.max(3, paneHeight - 12));
  const maxTaskNameChars = Math.max(12, Math.min(60, paneWidth - 16));
  const progressBarWidth = Math.max(8, Math.min(20, paneWidth - 22));
  const innerWidth = Math.max(1, paneWidth - 2);

  return (
    <Box
      flexDirection="column"
      height={paneHeight}
      width={paneWidth}
      paddingX={1}
      overflow="hidden"
    >
      {/* Header */}
      <Box marginBottom={0} overflow="hidden">
        <Text bold color={isFocused ? "cyan" : "white"} wrap="truncate">
          Tasks{editMode ? " [edit]" : ""}{" "}
          <Text dimColor>
            ({visibleTasks.length}/{tasks.length})
          </Text>
          {showFinishedTasks ? <Text dimColor> (all)</Text> : null}
        </Text>
      </Box>

      {/* Task List */}
      <Box
        flexDirection="column"
        height={taskListHeight}
        width={innerWidth}
        overflow="hidden"
      >
        {visibleTasks.length === 0 ? (
          <Text dimColor italic wrap="truncate">
            {tasks.length === 0 ? "No tasks." : "No open tasks."}
          </Text>
        ) : (
          visibleTasks.map((task, index) => {
            const isSelected = index === validSelectedIndex && isFocused;
            const isCurrent = task.id === currentTaskId;
            const status = task.metadata?.status ?? "pending";
            const progress = task.metadata?.progress ?? 0;
            const userStatus = getTaskUserStatus(task.metadata?.userStatus);

            const displayName = task.name.substring(0, maxTaskNameChars);
            const clipped = task.name.length > maxTaskNameChars ? "..." : "";

            return (
              <Box key={task.id}>
                <Text
                  color={isSelected ? "cyan" : isCurrent ? "yellow" : "white"}
                  bold={isCurrent}
                  inverse={isSelected}
                  wrap="truncate"
                >
                  {isSelected ? "▶ " : "  "}
                  {getStatusIcon(status)} {displayName}
                  {clipped}
                  <Text dimColor> ({progress}%)</Text>
                  {userStatus === "done" && <Text dimColor> ✓</Text>}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Current Task Details */}
      {currentTask && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor={isFocused ? "cyan" : "gray"}
          flexGrow={1}
          paddingX={1}
          paddingY={0}
          width={innerWidth}
        >
          {/* Task Header */}
          <Box>
            <Text
              bold
              color={getStatusColor(currentTask.metadata?.status ?? "pending")}
              wrap="truncate"
            >
              {getStatusIcon(currentTask.metadata?.status ?? "pending")}{" "}
              {currentTask.name}
            </Text>
          </Box>

          {/* Progress Bar */}
          <Box marginY={0}>
            <Text dimColor>Progress: </Text>
            <ProgressBar
              progress={currentTask.metadata?.progress ?? 0}
              width={progressBarWidth}
            />
            <Text> {currentTask.metadata?.progress ?? 0}%</Text>
          </Box>

          {/* Description */}
          {currentTask.description && (
            <Box marginY={0}>
              <Text dimColor wrap="truncate">
                {currentTask.description.substring(0, 100)}
              </Text>
            </Box>
          )}

          <Box marginY={0}>
            <Text dimColor wrap="truncate">
              Sub-agent: {currentTask.metadata?.subAgentType ?? "eliza"}
            </Text>
          </Box>

          {/* Output / Trace */}
          <Box
            flexDirection="column"
            marginTop={1}
            flexGrow={1}
            overflow="hidden"
          >
            <Text dimColor bold wrap="truncate">
              {detailView === "output" ? "Output" : "Trace"}
              {currentTask.metadata?.status === "running" ? " (live)" : ""}
            </Text>
            {visibleDetail.length === 0 ? (
              <Text dimColor italic wrap="truncate">
                {detailView === "output" ? "No output yet." : "No trace yet."}
              </Text>
            ) : (
              visibleDetail.map((line, i) => {
                const isError =
                  line.startsWith("❌") ||
                  line.startsWith("⚠️") ||
                  line.startsWith("Error:") ||
                  line.startsWith("ERROR:");
                const isSuccess =
                  line.startsWith("🎉") ||
                  line.startsWith("✅") ||
                  line.startsWith("Done:");
                const isTool =
                  line.startsWith("🔧") ||
                  line.startsWith("Tools:") ||
                  line.startsWith("TOOL:") ||
                  line.startsWith("[");
                const isAgent =
                  line.startsWith("🤖") ||
                  line.startsWith("🧠") ||
                  line.startsWith("#");

                let color: string | undefined;
                if (isError) color = "red";
                else if (isSuccess) color = "green";
                else if (isTool) color = "yellow";
                else if (isAgent) color = "cyan";

                const clipped =
                  line.length > maxOutputChars
                    ? `${line.slice(0, Math.max(0, maxOutputChars - 1))}…`
                    : line;

                return (
                  <Text key={i} color={color} dimColor={!color} wrap="truncate">
                    {clipped}
                  </Text>
                );
              })
            )}
            {detailScrollOffset > 0 && (
              <Text dimColor>[↓ {detailScrollOffset} newer lines]</Text>
            )}
          </Box>

          {/* Result / Files */}
          {currentTask.metadata?.result && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor bold wrap="truncate">
                Result:
              </Text>
              <Text dimColor wrap="truncate">
                {currentTask.metadata.result.summary.substring(0, 70)}
              </Text>
              {(currentTask.metadata.result.filesCreated.length > 0 ||
                currentTask.metadata.result.filesModified.length > 0) && (
                <Box flexDirection="column" marginTop={0}>
                  {currentTask.metadata.result.filesCreated.length > 0 && (
                    <Text dimColor wrap="truncate">
                      +{" "}
                      {currentTask.metadata.result.filesCreated
                        .slice(0, 5)
                        .join(", ")}
                      {currentTask.metadata.result.filesCreated.length > 5
                        ? "..."
                        : ""}
                    </Text>
                  )}
                  {currentTask.metadata.result.filesModified.length > 0 && (
                    <Text dimColor wrap="truncate">
                      ~{" "}
                      {currentTask.metadata.result.filesModified
                        .slice(0, 5)
                        .join(", ")}
                      {currentTask.metadata.result.filesModified.length > 5
                        ? "..."
                        : ""}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}

          {/* Error Display */}
          {currentTask.metadata?.error && (
            <Box marginTop={1}>
              <Text color="red" bold>
                Error:{" "}
              </Text>
              <Text color="red" wrap="truncate">
                {currentTask.metadata.error.substring(0, 200)}
              </Text>
            </Box>
          )}
        </Box>
      )}

      {/* Rename input (edit mode) */}
      {isFocused && editMode && isRenaming && (
        <Box
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          marginTop={0}
          overflow="hidden"
          width={innerWidth}
        >
          <Text dimColor wrap="truncate">
            Rename:
          </Text>
          <TextInput
            value={renameDraft}
            onChange={setRenameDraft}
            focus={true}
          />
        </Box>
      )}

      {/* Help text */}
      <Box marginTop={0}>
        <Text dimColor wrap="truncate">
          {!isFocused
            ? "Tab: focus tasks"
            : confirm
              ? `Confirm ${confirm.type}? (y/n)`
              : editMode
                ? "Edit: a agent • r rename • p pause/resume • c cancel • x delete • t trace • e exit • f finished"
                : "↑↓ select • Enter switch • e edit • t trace • d done/open • f finished"}
        </Text>
      </Box>
    </Box>
  );
}

function ProgressBar({ progress, width }: { progress: number; width: number }) {
  const filled = Math.round((progress / 100) * width);
  const empty = width - filled;

  return (
    <Text>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
    </Text>
  );
}

function formatTraceLines(events: TaskTraceEvent[]): string[] {
  const lines: string[] = [];

  for (const event of events) {
    const head = `#${event.seq}`;

    switch (event.kind) {
      case "status": {
        const msg = event.message ? ` — ${event.message}` : "";
        lines.push(`${head} ⏸️ ${event.status}${msg}`);
        break;
      }
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
      case "llm": {
        lines.push(
          `${head} 🤖 LLM iter ${event.iteration} (${event.modelType})`,
        );
        lines.push(`  ${event.responsePreview}`);
        if (event.prompt) {
          lines.push(`  🧪 prompt:`);
          lines.push(...indentLines(event.prompt.split("\n"), "    "));
        }
        lines.push(`  🧠 response:`);
        lines.push(...indentLines(event.response.split("\n"), "    "));
        break;
      }
      case "tool_call": {
        lines.push(
          `${head} 🔧 TOOL: ${formatToolCallArgs(event.name, event.args)}`,
        );
        break;
      }
      case "tool_result": {
        const status = event.success ? "✓" : "✗";
        lines.push(`${head} 🔧 RESULT: ${event.name} ${status}`);
        lines.push(`  ${event.outputPreview}`);
        lines.push(...indentLines(event.output.split("\n"), "    "));
        break;
      }
      default: {
        const _exhaustive: never = event;
        return lines;
      }
    }
  }

  return lines;
}

function indentLines(input: string[], prefix: string): string[] {
  return input.map((line) => `${prefix}${line}`);
}

function formatToolCallArgs(
  name: string,
  args: Record<string, string>,
): string {
  const argsText = Object.entries(args)
    .map(([k, v]) => `${k}="${v.replace(/\s+/g, " ").trim()}"`)
    .join(", ");
  return `${name}(${argsText})`;
}
