import type { AgentRuntime } from "@elizaos/core";
import type { AgentOrchestratorService as CodeTaskService } from "@elizaos/plugin-agent-orchestrator";
import { Box, type Key, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPane } from "./components/ChatPane.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskPane } from "./components/TaskPane.js";
import { getAgentClient } from "./lib/agent-client.js";
import { getCwd, setCwd } from "./lib/cwd.js";
import { useStore } from "./lib/store.js";
import { handleTaskSlashCommand } from "./lib/task-slash-command.js";
import type { SubAgentType, TaskEvent } from "./types.js";

interface AppProps {
  runtime: AgentRuntime;
}

function parseYesNo(text: string): "yes" | "no" | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const yesValues = new Set([
    "y",
    "yes",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "resume",
    "start",
    "restart",
    "run",
    "continue",
  ]);
  const noValues = new Set([
    "n",
    "no",
    "nope",
    "nah",
    "later",
    "skip",
    "pause",
    "paused",
    "keep paused",
    "not now",
  ]);

  if (yesValues.has(normalized)) return "yes";
  if (noValues.has(normalized)) return "no";
  return null;
}

export function App({ runtime }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [startupResumeTaskIds, setStartupResumeTaskIds] = useState<
    string[] | null
  >(null);
  const didCheckInterruptedTasks = useRef(false);
  const [showHelpOverlay, setShowHelpOverlay] = useState(false);

  const [terminalSize, setTerminalSize] = useState<{
    rows: number;
    columns: number;
  }>(() => ({
    rows: stdout?.rows ?? 24,
    columns: stdout?.columns ?? 80,
  }));

  useEffect(() => {
    if (!stdout) return;

    const update = () => {
      setTerminalSize({
        rows: stdout.rows ?? 24,
        columns: stdout.columns ?? 80,
      });
    };

    update();
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  const terminalHeight = terminalSize.rows;
  const terminalWidth = terminalSize.columns;

  const {
    focusedPane,
    togglePane,
    createRoom,
    switchRoom,
    deleteRoom,
    rooms,
    addMessage,
    appendToMessage,
    clearMessages,
    setTasks,
    setCurrentTaskId,
    setSelectedSubAgentType,
    setTaskPaneVisibility,
    taskPaneVisibility,
    taskPaneWidthFraction,
    adjustTaskPaneWidth,
    setLoading,
    setAgentTyping,
    currentRoomId,
    isTaskPaneVisible,
    loadSessionState,
    selectedSubAgentType,
  } = useStore();

  const showTaskPane = isTaskPaneVisible();

  // Load session on startup
  useEffect(() => {
    loadSessionState().then(() => {
      setInitialized(true);
    });
  }, [loadSessionState]);

  // Initialize managers after session loaded
  useEffect(() => {
    if (!initialized) return;

    const agentClient = getAgentClient();
    agentClient.setRuntime(runtime);

    // Get task service and sync tasks to UI
    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (service) {
      // Sync current task from session
      const storedTaskId = useStore.getState().currentTaskId;

      // Initial sync
      service.getTasks().then((tasks) => {
        setTasks(tasks);

        // Restore task selection from session or get from service
        if (storedTaskId && tasks.some((t) => t.id === storedTaskId)) {
          service.setCurrentTask(storedTaskId);
        } else {
          const currentId = service.getCurrentTaskId();
          if (currentId) {
            setCurrentTaskId(currentId);
          }
        }
      });

      // Listen for task events
      const handleTaskEvent = async (event: TaskEvent) => {
        const tasks = await service.getTasks();
        setTasks(tasks);

        if (event.type === "task:created") {
          const currentId = service.getCurrentTaskId();
          if (currentId) setCurrentTaskId(currentId);
        }

        // Mirror key task messages into the chat log (so users can watch work happen).
        if (event.type === "task:message") {
          const msg = event.data?.message;
          const taskId = event.taskId;
          const text =
            typeof msg === "string" && msg.length > 0 ? msg : undefined;
          if (text) {
            const activeRoomId = useStore.getState().currentRoomId;
            addMessage(activeRoomId, "assistant", text, taskId);
          }
        }
      };

      service.on("task", handleTaskEvent);

      return () => {
        service.off("task", handleTaskEvent);
      };
    }
  }, [runtime, initialized, setTasks, setCurrentTaskId, addMessage]);

  // On startup: detect tasks that were left in "running" state (e.g., after exit/crash),
  // pause them, and prompt user whether to resume.
  useEffect(() => {
    if (!initialized) return;
    if (didCheckInterruptedTasks.current) return;

    const service = runtime.getService("CODE_TASK") as CodeTaskService | null;
    if (!service) return;

    didCheckInterruptedTasks.current = true;

    service
      .detectAndPauseInterruptedTasks()
      .then((pausedTasks) => {
        if (pausedTasks.length === 0) return;
        const ids = pausedTasks
          .map((t) => t.id ?? "")
          .filter((id) => id.length > 0);
        if (ids.length === 0) return;

        setStartupResumeTaskIds(ids);

        const preview = pausedTasks
          .slice(0, 5)
          .map((t) => `- ${t.name} (${t.metadata.progress ?? 0}%)`)
          .join("\n");

        addMessage(
          currentRoomId,
          "system",
          `Found ${ids.length} previously-running task(s). Paused.\nResume now? (y/n)\n\n${preview}`,
        );
      })
      .catch(() => {
        // Ignore startup resume prompt errors.
      });
  }, [initialized, runtime, addMessage, currentRoomId]);

  // Handle slash commands
  const handleSlashCommand = useCallback(
    async (command: string, args: string): Promise<boolean> => {
      const service = runtime.getService("CODE_TASK") as CodeTaskService | null;

      switch (command.toLowerCase()) {
        // =====================
        // Sub-agent selection
        // =====================
        case "agent":
        case "subagent":
        case "worker": {
          const trimmed = args.trim();
          if (!trimmed) {
            addMessage(
              currentRoomId,
              "system",
              `Active agent: ${selectedSubAgentType ?? "(not set)"}\n\nUsage: /agent <type>\nTypes:\n- eliza\n- claude-code\n- codex\n- opencode\n- sweagent\n- elizaos-native`,
            );
            return true;
          }

          const [typeRaw] = trimmed.split(/\s+/);
          const next = normalizeSubAgentType(typeRaw);
          if (!next) {
            addMessage(
              currentRoomId,
              "system",
              `Unknown agent type: "${typeRaw}". Try: eliza, claude-code, codex, opencode, sweagent, elizaos-native`,
            );
            return true;
          }

          setSelectedSubAgentType(next);
          process.env.ELIZA_CODE_ACTIVE_SUB_AGENT = next;
          addMessage(currentRoomId, "system", `Active agent: ${next}`);
          return true;
        }

        // =====================
        // Task Commands
        // =====================
        case "task": {
          return handleTaskSlashCommand(args, {
            service,
            currentRoomId,
            addMessage,
            setCurrentTaskId,
            setTaskPaneVisibility,
            taskPaneVisibility,
            showTaskPane,
          });
        }

        case "tasks": {
          const trimmed = args.trim();
          if (!trimmed) {
            // Shortcut for /task list
            return handleSlashCommand("task", "list");
          }
          const mode = trimmed.toLowerCase();
          if (
            mode === "show" ||
            mode === "hide" ||
            mode === "auto" ||
            mode === "toggle"
          ) {
            return handleSlashCommand("task", `pane ${mode}`);
          }
          return handleSlashCommand("task", "list");
        }

        // =====================
        // Directory Commands
        // =====================
        case "cd":
        case "cwd": {
          const targetPath = args.trim();
          if (!targetPath) {
            addMessage(currentRoomId, "system", `CWD: ${getCwd()}`);
            return true;
          }
          const result = await setCwd(targetPath);
          if (result.success) {
            addMessage(currentRoomId, "system", `CWD: ${result.path}`);
          } else {
            addMessage(currentRoomId, "system", `Error: ${result.error}`);
          }
          return true;
        }

        case "pwd": {
          addMessage(currentRoomId, "system", getCwd());
          return true;
        }

        // =====================
        // Conversation Commands
        // =====================
        case "new": {
          const name = args.trim() || `Chat ${rooms.length + 1}`;
          const newRoom = createRoom(name);
          addMessage(newRoom.id, "system", `Started: ${name}`);
          return true;
        }

        case "reset": {
          const room = rooms.find((r) => r.id === currentRoomId);
          clearMessages(currentRoomId);
          if (room) {
            try {
              const agentClient = getAgentClient();
              await agentClient.clearConversation(room);
            } catch {
              // Ignore runtime clearing errors
            }
          }
          addMessage(
            currentRoomId,
            "system",
            `Conversation reset: ${room?.name ?? "Chat"}`,
          );
          return true;
        }

        case "conversations":
        case "chats": {
          if (rooms.length === 0) {
            addMessage(currentRoomId, "system", "No conversations yet.");
            return true;
          }
          const roomList = rooms
            .map((r, idx) => {
              const isCurrent = r.id === currentRoomId;
              const marker = isCurrent ? "→ " : "  ";
              const msgCount = r.messages.length;
              return `${marker}${idx + 1}. ${r.name} (${msgCount} messages)`;
            })
            .join("\n");
          addMessage(
            currentRoomId,
            "system",
            `Conversations:\n${roomList}\n\nUse /switch <n|name>.`,
          );
          return true;
        }

        case "switch": {
          const query = args.trim();
          if (!query) {
            addMessage(
              currentRoomId,
              "system",
              "Usage: /switch <number or name>\n\nUse `/conversations` to see available conversations.",
            );
            return true;
          }

          // Try to match by number first
          const num = parseInt(query, 10);
          let targetRoom = null;
          if (!Number.isNaN(num) && num >= 1 && num <= rooms.length) {
            targetRoom = rooms[num - 1];
          } else {
            // Match by name (case-insensitive partial match)
            const lowerQuery = query.toLowerCase();
            targetRoom = rooms.find(
              (r) =>
                r.name.toLowerCase() === lowerQuery ||
                r.name.toLowerCase().includes(lowerQuery),
            );
          }

          if (!targetRoom) {
            addMessage(
              currentRoomId,
              "system",
              `No conversation found matching: "${query}"\n\nUse \`/conversations\` to see available conversations.`,
            );
            return true;
          }

          if (targetRoom.id === currentRoomId) {
            addMessage(
              currentRoomId,
              "system",
              `Already in: ${targetRoom.name}`,
            );
            return true;
          }

          switchRoom(targetRoom.id);
          addMessage(
            targetRoom.id,
            "system",
            `Switched to: ${targetRoom.name}`,
          );
          return true;
        }

        case "rename": {
          const newName = args.trim();
          if (!newName) {
            addMessage(currentRoomId, "system", "Usage: /rename <new name>");
            return true;
          }
          // Update room name in store
          useStore.setState((state) => ({
            rooms: state.rooms.map((r) =>
              r.id === currentRoomId ? { ...r, name: newName } : r,
            ),
          }));
          addMessage(currentRoomId, "system", `Renamed to: ${newName}`);
          return true;
        }

        case "delete": {
          const query = args.trim();
          if (!query) {
            addMessage(
              currentRoomId,
              "system",
              "Usage: /delete <number or name>\n\nNote: Cannot delete the current conversation. Switch first.",
            );
            return true;
          }

          // Try to match by number first
          const num = parseInt(query, 10);
          let targetRoom = null;
          if (!Number.isNaN(num) && num >= 1 && num <= rooms.length) {
            targetRoom = rooms[num - 1];
          } else {
            // Match by name (case-insensitive partial match)
            const lowerQuery = query.toLowerCase();
            targetRoom = rooms.find(
              (r) =>
                r.name.toLowerCase() === lowerQuery ||
                r.name.toLowerCase().includes(lowerQuery),
            );
          }

          if (!targetRoom) {
            addMessage(
              currentRoomId,
              "system",
              `No conversation found matching: "${query}"`,
            );
            return true;
          }

          if (targetRoom.id === currentRoomId) {
            addMessage(
              currentRoomId,
              "system",
              "Cannot delete current conversation. Switch first.",
            );
            return true;
          }

          if (rooms.length <= 1) {
            addMessage(
              currentRoomId,
              "system",
              "Cannot delete the only conversation.",
            );
            return true;
          }

          // Best-effort: clear runtime memory for the deleted room to avoid ghost context.
          try {
            const agentClient = getAgentClient();
            await agentClient.clearConversation(targetRoom);
          } catch {
            // ignore
          }

          deleteRoom(targetRoom.id);
          addMessage(currentRoomId, "system", `Deleted: ${targetRoom.name}`);
          return true;
        }

        // =====================
        // Chat Commands
        // =====================
        case "clear": {
          clearMessages(currentRoomId);
          return true;
        }

        case "help": {
          addMessage(
            currentRoomId,
            "system",
            `Commands:
Conversations: /new [name], /conversations, /switch <n|name>, /rename <name>, /delete <n|name>, /reset
Agent: /agent <type>
Tasks: /task, /tasks
Dir: /cd [path], /pwd
UI: /clear
Help: /help, ?

Shortcuts: Tab panes, Ctrl+< > resize tasks, Ctrl+N new chat, Ctrl+C quit`,
          );
          return true;
        }

        default:
          return false;
      }
    },
    [
      currentRoomId,
      addMessage,
      runtime,
      setCurrentTaskId,
      setSelectedSubAgentType,
      setTaskPaneVisibility,
      taskPaneVisibility,
      showTaskPane,
      rooms,
      switchRoom,
      deleteRoom,
      clearMessages,
      createRoom,
      selectedSubAgentType,
    ],
  );

  // Handle sending messages
  const handleSendMessage = useCallback(
    async (text: string) => {
      // If we're awaiting a startup resume decision, consume the next user message.
      if (startupResumeTaskIds && startupResumeTaskIds.length > 0) {
        addMessage(currentRoomId, "user", text);

        const decision = parseYesNo(text);
        if (!decision) {
          addMessage(
            currentRoomId,
            "system",
            `Reply y/n to resume ${startupResumeTaskIds.length} task(s).`,
          );
          return;
        }

        const service = runtime.getService(
          "CODE_TASK",
        ) as CodeTaskService | null;
        if (!service) {
          addMessage(currentRoomId, "system", "Task service not available");
          setStartupResumeTaskIds(null);
          return;
        }

        if (decision === "no") {
          addMessage(
            currentRoomId,
            "system",
            "OK — tasks remain paused. Use /task resume to resume.",
          );
          setStartupResumeTaskIds(null);
          return;
        }

        addMessage(
          currentRoomId,
          "system",
          `Resuming ${startupResumeTaskIds.length} task(s)…`,
        );
        for (const taskId of startupResumeTaskIds) {
          service.startTaskExecution(taskId).then(
            () => {},
            (err: Error) => {
              const msg = err.message;
              addMessage(
                currentRoomId,
                "system",
                `Failed to start task ${taskId.slice(0, 8)}: ${msg}`,
              );
            },
          );
        }
        setStartupResumeTaskIds(null);
        return;
      }

      // Check for slash commands
      if (text.startsWith("/")) {
        const [command, ...argParts] = text.slice(1).split(" ");
        const args = argParts.join(" ");
        const handled = await handleSlashCommand(command, args);
        if (handled) return;
      }

      setLoading(true);
      setAgentTyping(true);
      setError(null);

      try {
        const state = useStore.getState();
        const roomId = state.currentRoomId;
        const room = state.rooms.find((r) => r.id === roomId);
        if (!room) {
          throw new Error("Current conversation not found");
        }

        addMessage(roomId, "user", text);

        const agentClient = getAgentClient();
        const placeholder = addMessage(roomId, "assistant", "", undefined);
        const _response = await agentClient.sendMessage({
          room,
          text,
          identity: state.identity,
          onDelta: (delta) => {
            appendToMessage(roomId, placeholder.id, delta);
          },
        });

        const service = runtime.getService(
          "CODE_TASK",
        ) as CodeTaskService | null;
        const currentTask = service ? await service.getCurrentTask() : null;
        // Ensure the streamed message is tagged with the current task (if any).
        if (currentTask?.id) {
          useStore.setState((s) => ({
            rooms: s.rooms.map((r) =>
              r.id === roomId
                ? {
                    ...r,
                    messages: r.messages.map((m) =>
                      m.id === placeholder.id
                        ? { ...m, taskId: currentTask.id }
                        : m,
                    ),
                  }
                : r,
            ),
          }));
        }
        // (placeholder content is already updated via streaming)
      } finally {
        setLoading(false);
        setAgentTyping(false);
      }
    },
    [
      currentRoomId,
      addMessage,
      appendToMessage,
      setLoading,
      setAgentTyping,
      handleSlashCommand,
      runtime.getService,
      startupResumeTaskIds,
    ],
  );

  // Global keyboard shortcuts
  useInput((char: string, key: Key) => {
    if (showHelpOverlay) {
      if (
        key.escape ||
        char === "?" ||
        (key.ctrl && (char === "h" || char === "H"))
      ) {
        setShowHelpOverlay(false);
      }
      return;
    }

    if (char === "?" || (key.ctrl && (char === "h" || char === "H"))) {
      setShowHelpOverlay(true);
      return;
    }

    // Ctrl+C or Ctrl+Q to quit
    if ((char === "c" && key.ctrl) || (char === "q" && key.ctrl)) {
      // Save session before exit
      useStore.getState().saveSessionState();
      exit();
    }
    if (key.tab) {
      const state = useStore.getState();
      const isCommandMode =
        state.focusedPane === "chat" &&
        state.inputValue.trimStart().startsWith("/");
      if (!isCommandMode) {
        togglePane();
      }
    }

    // Ctrl+< / Ctrl+> (also accept Ctrl+, / Ctrl+.) to resize the task pane width.
    if (key.ctrl) {
      const dec = char === "<" || char === ",";
      const inc = char === ">" || char === ".";
      if (dec) {
        adjustTaskPaneWidth(-0.05);
        return;
      }
      if (inc) {
        adjustTaskPaneWidth(0.05);
        return;
      }
    }

    if (char === "n" && key.ctrl) {
      const state = useStore.getState();
      const name = `Chat ${state.rooms.length + 1}`;
      const newRoom = createRoom(name);
      addMessage(newRoom.id, "system", `Started: ${name}`);
    }
  });

  // Show loading state while initializing
  if (!initialized) {
    return (
      <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
        <Box justifyContent="center" alignItems="center" flexGrow={1}>
          <Text color="cyan">Loading session...</Text>
        </Box>
      </Box>
    );
  }

  const headerHeight = 1;
  const statusBarHeight = 3;
  const availableMainHeight = terminalHeight - headerHeight - statusBarHeight;
  const mainHeight = Math.max(1, availableMainHeight);

  const minChatWidth = 30;
  const minTasksWidth = 24;

  const desiredTasksWidth = Math.floor(terminalWidth * taskPaneWidthFraction);
  const canSplit =
    showTaskPane && terminalWidth >= minChatWidth + minTasksWidth;
  const tasksWidth = canSplit
    ? Math.max(
        minTasksWidth,
        Math.min(desiredTasksWidth, terminalWidth - minChatWidth),
      )
    : 0;
  const chatWidth = terminalWidth - tasksWidth;

  if (showHelpOverlay) {
    return <HelpOverlay width={terminalWidth} height={terminalHeight} />;
  }

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
      {/* Header */}
      <Box paddingX={1} height={headerHeight} overflow="hidden">
        <Text wrap="truncate">
          <Text bold color="magenta">
            Eliza Code
          </Text>
          {error && <Text color="red"> | Error: {error.substring(0, 60)}</Text>}
        </Text>
      </Box>

      {/* Main content area */}
      <Box height={mainHeight} flexDirection="row" width="100%">
        {/* Chat pane */}
        <Box
          width={chatWidth}
          height={mainHeight}
          borderStyle="single"
          borderColor={focusedPane === "chat" ? "cyan" : "gray"}
          overflow="hidden"
        >
          <ChatPane
            onSendMessage={handleSendMessage}
            isFocused={focusedPane === "chat"}
            paneWidth={Math.max(1, chatWidth - 2)}
            paneHeight={Math.max(1, mainHeight - 2)}
          />
        </Box>

        {/* Task pane */}
        {showTaskPane && (
          <Box
            width={tasksWidth}
            height={mainHeight}
            borderStyle="single"
            borderColor={focusedPane === "tasks" ? "cyan" : "gray"}
            overflow="hidden"
          >
            <TaskPane
              isFocused={focusedPane === "tasks"}
              paneHeight={Math.max(1, mainHeight - 2)}
              paneWidth={Math.max(1, tasksWidth - 2)}
              taskService={
                (runtime.getService("CODE_TASK") as CodeTaskService | null) ??
                null
              }
            />
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box height={statusBarHeight}>
        <StatusBar />
      </Box>
    </Box>
  );
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
