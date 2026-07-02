import {
  type ActionEventPayload,
  type AgentRuntime,
  EventType,
} from "@elizaos/core";
import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
  type OverlayHandle,
  TUI,
} from "@elizaos/tui";
import { ChatPane } from "./components/ChatPane.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { MainScreen } from "./components/MainScreen.js";
import { StatusBar } from "./components/StatusBar.js";
import { TaskPane } from "./components/TaskPane.js";
import { getAgentClient } from "./lib/agent-client.js";
import { osc52 } from "./lib/clipboard.js";
import { getCwd, setCwd } from "./lib/cwd.js";
import { FilteringTerminal } from "./lib/filtering-terminal.js";
import { getCodeTaskService } from "./lib/get-code-task-service.js";
import { useStore } from "./lib/store.js";
import {
  actionNameFromPayload,
  formatToolCompleted,
  formatToolStarted,
  shouldShowToolAction,
  toolTranscriptKey,
} from "./lib/tool-transcript.js";
import type {
  CodeTask,
  CodeTaskService,
  SubAgentType,
  TaskEvent,
  TaskPaneVisibility,
} from "./types.js";

interface TaskSlashCommandDeps {
  service: CodeTaskService | null | undefined;
  currentRoomId: string;
  addMessage: (
    roomId: string,
    role: "system",
    content: string,
    taskId?: string,
  ) => unknown;
  setCurrentTaskId: (taskId: string | null) => void;
  setTaskPaneVisibility: (visibility: TaskPaneVisibility) => void;
  taskPaneVisibility: TaskPaneVisibility;
  showTaskPane: boolean;
}

async function handleTaskSlashCommand(
  args: string,
  deps: TaskSlashCommandDeps,
): Promise<boolean> {
  const { currentRoomId, addMessage, service } = deps;
  if (!service) {
    addMessage(currentRoomId, "system", "Task service is unavailable.");
    return true;
  }

  const [subcommandRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = (subcommandRaw ?? "list").toLowerCase();
  const query = rest.join(" ").trim();

  if (subcommand === "help") {
    addMessage(
      currentRoomId,
      "system",
      [
        "Task commands:",
        "/task list",
        "/task current",
        "/task switch <number|id|name>",
        "/task pause [number|id|name]",
        "/task resume [number|id|name]",
        "/task cancel [number|id|name]",
        "/task pane show|hide|auto|toggle",
      ].join("\n"),
    );
    return true;
  }

  if (subcommand === "pane") {
    const next = resolveTaskPaneVisibility(
      query,
      deps.taskPaneVisibility,
      deps.showTaskPane,
    );
    if (!next) {
      addMessage(
        currentRoomId,
        "system",
        "Usage: /task pane show|hide|auto|toggle",
      );
      return true;
    }
    deps.setTaskPaneVisibility(next);
    addMessage(currentRoomId, "system", `Task pane: ${next}`);
    return true;
  }

  const tasks = await refreshTaskStore(service);

  if (subcommand === "list") {
    addMessage(currentRoomId, "system", formatTaskList(tasks));
    return true;
  }

  if (subcommand === "current") {
    const current = await service.getCurrentTask();
    addMessage(
      currentRoomId,
      "system",
      current ? formatTaskDetails(current) : "No current task selected.",
    );
    return true;
  }

  if (subcommand === "switch") {
    const task = resolveTaskQuery(tasks, query);
    const taskId = task ? getTaskId(task) : null;
    if (!task || !taskId) {
      addMessage(
        currentRoomId,
        "system",
        "Usage: /task switch <number|id|name>",
      );
      return true;
    }
    service.setCurrentTask(taskId);
    deps.setCurrentTaskId(taskId);
    addMessage(currentRoomId, "system", `Current task: ${task.name}`);
    return true;
  }

  if (["pause", "resume", "cancel"].includes(subcommand)) {
    const task = query
      ? resolveTaskQuery(tasks, query)
      : await service.getCurrentTask();
    const taskId = task ? getTaskId(task) : null;
    if (!task || !taskId) {
      addMessage(
        currentRoomId,
        "system",
        `No task found. Usage: /task ${subcommand} [number|id|name]`,
      );
      return true;
    }

    if (subcommand === "pause") {
      await service.pauseTask(taskId);
      addMessage(currentRoomId, "system", `Paused task: ${task.name}`);
    } else if (subcommand === "resume") {
      await service.resumeTask(taskId);
      await service.startTaskExecution(taskId);
      addMessage(currentRoomId, "system", `Resumed task: ${task.name}`);
    } else {
      await service.cancelTask(taskId);
      addMessage(currentRoomId, "system", `Cancelled task: ${task.name}`);
    }
    await refreshTaskStore(service);
    return true;
  }

  addMessage(
    currentRoomId,
    "system",
    `Unknown task command: ${subcommand}\nUse /task help.`,
  );
  return true;
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

function normalizeSubAgentType(input: string | undefined): SubAgentType | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;

  if (raw === "eliza") return "eliza";
  if (raw === "claude" || raw === "claude-code" || raw === "claudecode")
    return "claude-code";
  if (raw === "codex") return "codex";
  if (raw === "opencode" || raw === "open-code" || raw === "open_code")
    return "opencode";
  if (
    raw === "elizaos-native" ||
    raw === "eliza-native" ||
    raw === "native" ||
    raw === "elizaosnative"
  )
    return "elizaos-native";

  return null;
}

async function refreshTaskStore(service: CodeTaskService): Promise<CodeTask[]> {
  const tasks = await service.getTasks();
  const currentTaskId = service.getCurrentTaskId();
  useStore.getState().setTasks(tasks);
  useStore.getState().setCurrentTaskId(currentTaskId);
  return tasks;
}

function resolveTaskPaneVisibility(
  input: string,
  current: TaskPaneVisibility,
  visible: boolean,
): TaskPaneVisibility | null {
  const mode = input.trim().toLowerCase();
  if (mode === "show" || mode === "shown") return "shown";
  if (mode === "hide" || mode === "hidden") return "hidden";
  if (mode === "auto") return "auto";
  if (mode === "toggle") return visible ? "hidden" : "shown";
  if (!mode) return current;
  return null;
}

function resolveTaskQuery(tasks: CodeTask[], query: string): CodeTask | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= tasks.length) {
    return tasks[numeric - 1] ?? null;
  }

  const lower = trimmed.toLowerCase();
  return (
    tasks.find((task) => task.id === trimmed) ??
    tasks.find((task) => task.id?.startsWith(trimmed)) ??
    tasks.find((task) => task.name.toLowerCase() === lower) ??
    tasks.find((task) => task.name.toLowerCase().includes(lower)) ??
    null
  );
}

function getTaskId(task: CodeTask): string | null {
  return task.id ?? null;
}

function formatTaskList(tasks: CodeTask[]): string {
  if (tasks.length === 0) return "No tasks.";

  const currentTaskId = useStore.getState().currentTaskId;
  const lines = tasks.map((task, index) => {
    const marker = task.id === currentTaskId ? "->" : "  ";
    const status = task.metadata?.status ?? "pending";
    const progress = task.metadata?.progress ?? 0;
    const id = task.id ? task.id.slice(0, 8) : "no-id";
    return `${marker} ${index + 1}. ${task.name} [${status}, ${progress}%] ${id}`;
  });
  return `Tasks:\n${lines.join("\n")}`;
}

function formatTaskDetails(task: CodeTask): string {
  const status = task.metadata?.status ?? "pending";
  const progress = task.metadata?.progress ?? 0;
  const subAgent = task.metadata?.subAgentType ?? "(default)";
  const output = task.metadata?.output ?? [];
  const tail = output.slice(-3).join("\n");
  return [
    `Task: ${task.name}`,
    `ID: ${task.id}`,
    `Status: ${status}`,
    `Progress: ${progress}%`,
    `Agent: ${subAgent}`,
    tail ? `Recent output:\n${tail}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

// Slash command autocomplete items
const SLASH_COMMANDS: AutocompleteItem[] = [
  {
    label: "/copy",
    description: "Copy the last response to the clipboard",
    value: "/copy",
  },
  { label: "/new", description: "Start new conversation", value: "/new " },
  {
    label: "/reset",
    description: "Reset current conversation",
    value: "/reset",
  },
  {
    label: "/conversations",
    description: "List all conversations",
    value: "/conversations",
  },
  {
    label: "/chats",
    description: "List all conversations",
    value: "/chats",
  },
  {
    label: "/switch",
    description: "Switch conversation",
    value: "/switch ",
  },
  {
    label: "/rename",
    description: "Rename conversation",
    value: "/rename ",
  },
  {
    label: "/delete",
    description: "Delete a conversation",
    value: "/delete ",
  },
  {
    label: "/agent",
    description: "Select active worker sub-agent",
    value: "/agent ",
  },
  { label: "/task", description: "Task management", value: "/task " },
  {
    label: "/task list",
    description: "List all tasks",
    value: "/task list",
  },
  {
    label: "/task switch",
    description: "Switch to a task",
    value: "/task switch ",
  },
  {
    label: "/task current",
    description: "Show current task",
    value: "/task current",
  },
  {
    label: "/task pause",
    description: "Pause current task",
    value: "/task pause",
  },
  {
    label: "/task resume",
    description: "Resume task",
    value: "/task resume",
  },
  {
    label: "/task cancel",
    description: "Cancel a task",
    value: "/task cancel ",
  },
  {
    label: "/tasks",
    description: "List all tasks (shortcut)",
    value: "/tasks",
  },
  {
    label: "/task pane show",
    description: "Show tasks pane",
    value: "/task pane show",
  },
  {
    label: "/task pane hide",
    description: "Hide tasks pane",
    value: "/task pane hide",
  },
  {
    label: "/task pane auto",
    description: "Auto tasks pane",
    value: "/task pane auto",
  },
  {
    label: "/task pane toggle",
    description: "Toggle tasks pane",
    value: "/task pane toggle",
  },
  { label: "/cd", description: "Change directory", value: "/cd " },
  { label: "/pwd", description: "Show current directory", value: "/pwd" },
  { label: "/clear", description: "Clear chat history", value: "/clear" },
  { label: "/help", description: "Show all commands", value: "/help" },
];

export class App {
  private readonly terminal: FilteringTerminal;
  private readonly tui: TUI;
  private readonly mainScreen: MainScreen;
  private runtime: AgentRuntime;
  private chatPane: ChatPane;
  private taskPane: TaskPane;
  private statusBar: StatusBar;
  private helpOverlay: HelpOverlay | null = null;
  private helpOverlayHandle: OverlayHandle | null = null;
  private showingHelp = false;
  private startupResumeTaskIds: string[] | null = null;
  private didCheckInterruptedTasks = false;
  private exitResolver: (() => void) | null = null;
  private activeTurnAbortController: AbortController | null = null;
  private readonly toolMessageIds = new Map<string, string>();

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
    this.terminal = new FilteringTerminal((data: string) =>
      this.consumeGlobalInput(data),
    );
    this.tui = new TUI(this.terminal);

    const autocompleteProvider = new CombinedAutocompleteProvider(
      SLASH_COMMANDS,
    );

    this.chatPane = new ChatPane({
      onSubmit: (text) => this.handleSendMessage(text),
      autocompleteProvider,
      tui: this.tui,
    });

    this.taskPane = new TaskPane({
      runtime: this.runtime,
      tui: this.tui,
    });

    this.statusBar = new StatusBar();

    this.mainScreen = new MainScreen(
      this.terminal,
      this.statusBar,
      this.chatPane,
      this.taskPane,
    );
    this.tui.addChild(this.mainScreen);
    this.tui.setFocus(this.mainScreen);
  }

  async run(): Promise<void> {
    await useStore.getState().loadSessionState();

    this.initializeManagers();

    await this.checkInterruptedTasks();

    this.tui.start();

    await new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

  stop(): void {
    this.tui.stop();
    if (this.exitResolver) {
      this.exitResolver();
      this.exitResolver = null;
    }
  }

  private initializeManagers(): void {
    const agentClient = getAgentClient();
    agentClient.setRuntime(this.runtime);
    this.registerToolTranscriptEvents();

    // Get task service and sync tasks to UI
    const service = getCodeTaskService(this.runtime);
    if (service) {
      const state = useStore.getState();
      const storedTaskId = state.currentTaskId;

      // Initial sync
      service.getTasks().then((tasks: CodeTask[]) => {
        useStore.getState().setTasks(tasks);

        if (storedTaskId && tasks.some((t) => t.id === storedTaskId)) {
          service.setCurrentTask(storedTaskId);
        } else {
          const currentId = service.getCurrentTaskId();
          if (currentId) {
            useStore.getState().setCurrentTaskId(currentId);
          }
        }
        this.tui.requestRender();
      });

      // Listen for task events
      const handleTaskEvent = async (event: TaskEvent) => {
        const tasks = await service.getTasks();
        const state = useStore.getState();
        state.setTasks(tasks);

        if (event.type === "task:created") {
          const currentId = service.getCurrentTaskId();
          if (currentId) state.setCurrentTaskId(currentId);
        }

        // Mirror key task messages into the chat log
        if (event.type === "task:message") {
          const msg = event.data?.message;
          const taskId = event.taskId;
          const text =
            typeof msg === "string" && msg.length > 0 ? msg : undefined;
          if (text) {
            const activeRoomId = state.currentRoomId;
            state.addMessage(activeRoomId, "assistant", text, taskId);
          }
        }

        this.tui.requestRender();
      };

      service.on("task", handleTaskEvent);
    }
  }

  private registerToolTranscriptEvents(): void {
    this.runtime.registerEvent(
      EventType.ACTION_STARTED,
      async (payload: ActionEventPayload) => {
        this.handleToolActionStarted(payload);
      },
    );
    this.runtime.registerEvent(
      EventType.ACTION_COMPLETED,
      async (payload: ActionEventPayload) => {
        this.handleToolActionCompleted(payload);
      },
    );
  }

  private roomIdForAction(payload: ActionEventPayload): string {
    const state = useStore.getState();
    const room = state.rooms.find((candidate) => {
      return candidate.elizaRoomId === payload.roomId;
    });
    return room?.id ?? state.currentRoomId;
  }

  private handleToolActionStarted(payload: ActionEventPayload): void {
    const actionName = actionNameFromPayload(payload);
    if (!shouldShowToolAction(actionName)) return;

    const state = useStore.getState();
    const roomId = this.roomIdForAction(payload);
    const key = toolTranscriptKey(payload, actionName);
    const message = state.addMessage(
      roomId,
      "system",
      formatToolStarted(actionName),
      state.currentTaskId ?? undefined,
      "tool",
    );
    this.toolMessageIds.set(key, message.id);
    this.tui.requestRender();
  }

  private handleToolActionCompleted(payload: ActionEventPayload): void {
    const actionName = actionNameFromPayload(payload);
    if (!shouldShowToolAction(actionName)) return;

    const state = useStore.getState();
    const roomId = this.roomIdForAction(payload);
    const key = toolTranscriptKey(payload, actionName);
    const messageId = this.toolMessageIds.get(key);
    const line = formatToolCompleted(payload, { cwd: getCwd() });

    if (messageId) {
      state.setMessageContent(roomId, messageId, line);
      this.toolMessageIds.delete(key);
    } else {
      state.addMessage(
        roomId,
        "system",
        line,
        state.currentTaskId ?? undefined,
        "tool",
      );
    }
    this.tui.requestRender();
  }

  private async checkInterruptedTasks(): Promise<void> {
    if (this.didCheckInterruptedTasks) return;
    this.didCheckInterruptedTasks = true;

    const service = getCodeTaskService(this.runtime);
    if (!service) return;

    try {
      const pausedTasks = await service.detectAndPauseInterruptedTasks();
      if (pausedTasks.length === 0) return;

      const ids = pausedTasks
        .map((t: { id?: string }) => t.id ?? "")
        .filter((id: string) => id.length > 0);
      if (ids.length === 0) return;

      this.startupResumeTaskIds = ids;

      const preview = pausedTasks
        .slice(0, 5)
        .map(
          (t: { name: string; metadata: { progress?: number } }) =>
            `- ${t.name} (${t.metadata.progress ?? 0}%)`,
        )
        .join("\n");

      const state = useStore.getState();
      state.addMessage(
        state.currentRoomId,
        "system",
        `Found ${ids.length} previously-running task(s). Paused.\nResume now? (y/n)\n\n${preview}`,
      );
      this.tui.requestRender();
    } catch {
      // Ignore startup resume prompt errors
    }
  }

  /**
   * Global shortcuts handled before input reaches the focused TUI component.
   * @returns true when the keystroke was consumed.
   */
  private consumeGlobalInput(data: string): boolean {
    if ((data === "\x1b" || data === "\x03") && this.abortCurrentTurn()) {
      return true;
    }

    if (this.showingHelp) {
      // Ctrl+C / Ctrl+Q must still quit even with help open (they were trapped
      // before). Otherwise close on ?, Esc, Backspace (\x08 Ctrl+H and \x7f DEL,
      // which is what most terminals send), or q.
      if (data === "\x03" || data === "\x11") {
        useStore.getState().saveSessionState();
        this.stop();
        return true;
      }
      if (
        data === "?" ||
        data === "\x1b" ||
        data === "\x08" ||
        data === "\x7f" ||
        data === "q"
      ) {
        this.closeHelp();
      }
      return true;
    }

    // `?` opens help only when it can't be a character the user is typing:
    // task pane focused, or the chat composer is empty. Otherwise it must reach
    // the editor so prompts like "what does this do?" aren't corrupted.
    if (data === "?") {
      const state = useStore.getState();
      if (state.focusedPane !== "chat" || state.inputValue.trim() === "") {
        this.openHelp();
        return true;
      }
      return false;
    }

    if (data === "\x03" || data === "\x11") {
      useStore.getState().saveSessionState();
      this.stop();
      return true;
    }

    if (data === "\x0e") {
      const state = useStore.getState();
      const name = `Chat ${state.rooms.length + 1}`;
      const newRoom = state.createRoom(name);
      state.addMessage(newRoom.id, "system", `Started: ${name}`);
      this.tui.requestRender();
      return true;
    }

    if (data === "\t") {
      const state = useStore.getState();
      const isCommandMode = state.inputValue.trimStart().startsWith("/");
      if (!isCommandMode) {
        state.togglePane();
        this.mainScreen.invalidate();
        this.tui.requestRender();
        return true;
      }
      return false;
    }

    // Ctrl+←/→ always resizes the task pane. Bare ","/"." resize ONLY when the
    // task pane is focused — otherwise they are literal characters the chat
    // composer must receive (you couldn't type "Fix App.ts, please." before).
    const paneFocused = useStore.getState().focusedPane === "tasks";
    if (data === "\x1b[1;5D" || (data === "," && paneFocused)) {
      useStore.getState().adjustTaskPaneWidth(-0.05);
      this.tui.requestRender();
      return true;
    }
    if (data === "\x1b[1;5C" || (data === "." && paneFocused)) {
      useStore.getState().adjustTaskPaneWidth(0.05);
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  private abortCurrentTurn(): boolean {
    const controller = this.activeTurnAbortController;
    if (!controller) return false;
    if (controller.signal.aborted) {
      // Abort was already requested but the turn hasn't unwound yet (e.g. a
      // provider that ignores the signal). Let the keystroke fall through so
      // a second Ctrl+C reaches the quit handler instead of being eaten here.
      return false;
    }
    controller.abort();
    this.tui.requestRender();
    return true;
  }

  private openHelp(): void {
    this.showingHelp = true;
    if (!this.helpOverlay) {
      this.helpOverlay = new HelpOverlay(this.terminal);
    }
    this.helpOverlayHandle?.hide();
    this.helpOverlayHandle = this.tui.showOverlay(this.helpOverlay, {
      width: "88%",
      maxHeight: "85%",
      anchor: "center",
    });
    this.tui.requestRender();
  }

  private closeHelp(): void {
    this.showingHelp = false;
    this.helpOverlayHandle?.hide();
    this.helpOverlayHandle = null;
    this.tui.requestRender();
  }

  private async handleSlashCommand(
    command: string,
    args: string,
  ): Promise<boolean> {
    const state = useStore.getState();
    const { currentRoomId, addMessage, rooms } = state;
    const service = getCodeTaskService(this.runtime);

    switch (command.toLowerCase()) {
      // Sub-agent selection
      case "agent":
      case "subagent":
      case "worker": {
        const trimmed = args.trim();
        if (!trimmed) {
          addMessage(
            currentRoomId,
            "system",
            `Active agent: ${state.selectedSubAgentType ?? "(not set)"}\n\nUsage: /agent <type>\nTypes:\n- eliza\n- claude-code\n- codex\n- opencode\n- elizaos-native`,
          );
          this.tui.requestRender();
          return true;
        }

        const [typeRaw] = trimmed.split(/\s+/);
        const next = normalizeSubAgentType(typeRaw);
        if (!next) {
          addMessage(
            currentRoomId,
            "system",
            `Unknown agent type: "${typeRaw}". Try: eliza, claude-code, codex, opencode, elizaos-native`,
          );
          this.tui.requestRender();
          return true;
        }

        state.setSelectedSubAgentType(next);
        process.env.ELIZA_CODE_ACTIVE_SUB_AGENT = next;
        addMessage(currentRoomId, "system", `Active agent: ${next}`);
        this.tui.requestRender();
        return true;
      }

      // Task Commands
      case "task": {
        const result = await handleTaskSlashCommand(args, {
          service,
          currentRoomId,
          addMessage,
          setCurrentTaskId: state.setCurrentTaskId,
          setTaskPaneVisibility: state.setTaskPaneVisibility,
          taskPaneVisibility: state.taskPaneVisibility,
          showTaskPane: state.isTaskPaneVisible(),
        });
        this.tui.requestRender();
        return result;
      }

      case "tasks": {
        const trimmed = args.trim();
        if (!trimmed) {
          return this.handleSlashCommand("task", "list");
        }
        const mode = trimmed.toLowerCase();
        if (["show", "hide", "auto", "toggle"].includes(mode)) {
          return this.handleSlashCommand("task", `pane ${mode}`);
        }
        return this.handleSlashCommand("task", "list");
      }

      // Directory Commands
      case "cd":
      case "cwd": {
        const targetPath = args.trim();
        if (!targetPath) {
          addMessage(currentRoomId, "system", `CWD: ${getCwd()}`);
          this.tui.requestRender();
          return true;
        }
        const result = await setCwd(targetPath);
        if (result.success) {
          addMessage(currentRoomId, "system", `CWD: ${result.path}`);
        } else {
          addMessage(currentRoomId, "system", `Error: ${result.error}`);
        }
        this.tui.requestRender();
        return true;
      }

      case "pwd": {
        addMessage(currentRoomId, "system", getCwd());
        this.tui.requestRender();
        return true;
      }

      // Conversation Commands
      case "new": {
        const name = args.trim() || `Chat ${rooms.length + 1}`;
        const newRoom = state.createRoom(name);
        addMessage(newRoom.id, "system", `Started: ${name}`);
        this.tui.requestRender();
        return true;
      }

      case "reset": {
        const room = rooms.find((r) => r.id === currentRoomId);
        state.clearMessages(currentRoomId);
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
        this.tui.requestRender();
        return true;
      }

      case "conversations":
      case "chats": {
        if (rooms.length === 0) {
          addMessage(currentRoomId, "system", "No conversations yet.");
          this.tui.requestRender();
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
        this.tui.requestRender();
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
          this.tui.requestRender();
          return true;
        }

        const num = parseInt(query, 10);
        let targetRoom = null;
        if (!Number.isNaN(num) && num >= 1 && num <= rooms.length) {
          targetRoom = rooms[num - 1];
        } else {
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
          this.tui.requestRender();
          return true;
        }

        if (targetRoom.id === currentRoomId) {
          addMessage(currentRoomId, "system", `Already in: ${targetRoom.name}`);
          this.tui.requestRender();
          return true;
        }

        state.switchRoom(targetRoom.id);
        addMessage(targetRoom.id, "system", `Switched to: ${targetRoom.name}`);
        this.tui.requestRender();
        return true;
      }

      case "rename": {
        const newName = args.trim();
        if (!newName) {
          addMessage(currentRoomId, "system", "Usage: /rename <new name>");
          this.tui.requestRender();
          return true;
        }
        useStore.setState((s) => ({
          rooms: s.rooms.map((r) =>
            r.id === currentRoomId ? { ...r, name: newName } : r,
          ),
        }));
        addMessage(currentRoomId, "system", `Renamed to: ${newName}`);
        this.tui.requestRender();
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
          this.tui.requestRender();
          return true;
        }

        const num = parseInt(query, 10);
        let targetRoom = null;
        if (!Number.isNaN(num) && num >= 1 && num <= rooms.length) {
          targetRoom = rooms[num - 1];
        } else {
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
          this.tui.requestRender();
          return true;
        }

        if (targetRoom.id === currentRoomId) {
          addMessage(
            currentRoomId,
            "system",
            "Cannot delete current conversation. Switch first.",
          );
          this.tui.requestRender();
          return true;
        }

        if (rooms.length <= 1) {
          addMessage(
            currentRoomId,
            "system",
            "Cannot delete the only conversation.",
          );
          this.tui.requestRender();
          return true;
        }

        try {
          const agentClient = getAgentClient();
          await agentClient.clearConversation(targetRoom);
        } catch {
          // ignore
        }

        state.deleteRoom(targetRoom.id);
        addMessage(currentRoomId, "system", `Deleted: ${targetRoom.name}`);
        this.tui.requestRender();
        return true;
      }

      // Chat Commands
      case "clear": {
        state.clearMessages(currentRoomId);
        this.tui.requestRender();
        return true;
      }

      case "copy": {
        // Copy the last assistant reply to the system clipboard via OSC 52
        // (works over SSH / inside the cockpit PTY, where there's no direct
        // clipboard access).
        const room = rooms.find((r) => r.id === currentRoomId);
        const lastAssistant = [...(room?.messages ?? [])]
          .reverse()
          .find((m) => m.role === "assistant" && m.content.trim().length > 0);
        if (!lastAssistant) {
          addMessage(currentRoomId, "system", "Nothing to copy yet.");
          this.tui.requestRender();
          return true;
        }
        this.terminal.write(osc52(lastAssistant.content));
        addMessage(
          currentRoomId,
          "system",
          "Copied the last response to the clipboard.",
        );
        this.tui.requestRender();
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
UI: /clear, /copy
Help: /help, ?

Shortcuts: Tab panes, Ctrl+< > resize tasks, Ctrl+N new chat, Ctrl+C quit
During a turn: Enter queues the message, Esc/Ctrl+C aborts (queued messages are discarded), second Ctrl+C quits`,
        );
        this.tui.requestRender();
        return true;
      }

      default:
        return false;
    }
  }

  private async handleSendMessage(text: string): Promise<void> {
    const state = useStore.getState();

    // If we're awaiting a startup resume decision
    if (this.startupResumeTaskIds && this.startupResumeTaskIds.length > 0) {
      state.addMessage(state.currentRoomId, "user", text);

      const decision = parseYesNo(text);
      if (!decision) {
        state.addMessage(
          state.currentRoomId,
          "system",
          `Reply y/n to resume ${this.startupResumeTaskIds.length} task(s).`,
        );
        this.tui.requestRender();
        return;
      }

      const service = getCodeTaskService(this.runtime);
      if (!service) {
        state.addMessage(
          state.currentRoomId,
          "system",
          "Task service not available",
        );
        this.startupResumeTaskIds = null;
        this.tui.requestRender();
        return;
      }

      if (decision === "no") {
        state.addMessage(
          state.currentRoomId,
          "system",
          "OK — tasks remain paused. Use /task resume to resume.",
        );
        this.startupResumeTaskIds = null;
        this.tui.requestRender();
        return;
      }

      state.addMessage(
        state.currentRoomId,
        "system",
        `Resuming ${this.startupResumeTaskIds.length} task(s)…`,
      );
      for (const taskId of this.startupResumeTaskIds) {
        service.startTaskExecution(taskId).catch((err: Error) => {
          const msg = err.message;
          state.addMessage(
            state.currentRoomId,
            "system",
            `Failed to start task ${taskId.slice(0, 8)}: ${msg}`,
          );
        });
      }
      this.startupResumeTaskIds = null;
      this.tui.requestRender();
      return;
    }

    // Check for slash commands
    if (text.startsWith("/")) {
      const [command, ...argParts] = text.slice(1).split(" ");
      const args = argParts.join(" ");
      const handled = await this.handleSlashCommand(command, args);
      if (handled) return;
      // An unknown "/command" must NOT fall through to the LLM (it burns a turn
      // and confuses the model). Report it and stop — unless it's the "//literal"
      // escape hatch for genuinely sending slash-prefixed text.
      if (!text.startsWith("//")) {
        state.addMessage(
          state.currentRoomId,
          "system",
          `Unknown command: /${command} — type /help for the list.`,
        );
        this.tui.requestRender();
        return;
      }
    }

    // Queue-and-send (opencode behavior): a submission made while a turn is
    // running is buffered and fired when the turn completes, instead of
    // spawning a second concurrent turn.
    if (this.activeTurnAbortController) {
      const queueLength = state.enqueuePendingSubmission(text);
      state.addMessage(
        state.currentRoomId,
        "system",
        `Queued (${queueLength}): ${submissionPreview(text)} — sends when the current turn finishes. Esc/Ctrl+C aborts and discards the queue.`,
        state.currentTaskId ?? undefined,
        "tool",
      );
      this.tui.requestRender();
      return;
    }

    const turnAbortController = new AbortController();
    this.activeTurnAbortController = turnAbortController;
    state.setLoading(true);
    state.setAgentTyping(true);
    this.tui.requestRender();

    const roomId = state.currentRoomId;
    let placeholderId: string | null = null;
    try {
      const room = state.rooms.find((r) => r.id === roomId);
      if (!room) {
        throw new Error("Current conversation not found");
      }

      state.addMessage(roomId, "user", text);
      this.tui.requestRender();

      const agentClient = getAgentClient();
      const placeholder = state.addMessage(roomId, "assistant", "", undefined);
      placeholderId = placeholder.id;
      const response = await agentClient.sendMessage({
        room,
        text,
        identity: state.identity,
        abortSignal: turnAbortController.signal,
        onDelta: (delta) => {
          if (turnAbortController.signal.aborted) return;
          state.appendToMessage(roomId, placeholder.id, delta);
          this.tui.requestRender();
        },
      });

      if (response && !turnAbortController.signal.aborted) {
        state.setMessageContent(roomId, placeholder.id, response);
        this.tui.requestRender();
      }

      if (turnAbortController.signal.aborted) {
        if (placeholderId) {
          state.removeMessage(roomId, placeholderId);
          placeholderId = null;
        }
        state.addMessage(roomId, "system", "Turn aborted.");
        return;
      }

      const service = getCodeTaskService(this.runtime);
      const currentTask = service ? await service.getCurrentTask() : null;
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
    } catch (err) {
      // A provider error (network blip, 429, revoked key) or a missing-room
      // throw must NOT crash the app — before this, the rejection bubbled to
      // index.ts's unhandledRejection handler → process.exit(1), which left the
      // terminal in raw mode (raw-mode/bracketed-paste/cursor restore only runs
      // via app.stop()). Surface it as a system message and drop the empty
      // assistant placeholder so no blank bubble lingers.
      if (turnAbortController.signal.aborted || isAbortError(err)) {
        if (placeholderId) {
          state.removeMessage(roomId, placeholderId);
        }
        state.addMessage(roomId, "system", "Turn aborted.");
      } else {
        const messageText = err instanceof Error ? err.message : String(err);
        if (placeholderId) {
          state.removeMessage(roomId, placeholderId);
        }
        state.addMessage(roomId, "system", `Error: ${messageText}`);
      }
    } finally {
      if (this.activeTurnAbortController === turnAbortController) {
        this.activeTurnAbortController = null;
      }
      state.setLoading(false);
      state.setAgentTyping(false);
      // Drain the queue-and-send buffer. Abort means "stop everything", so an
      // aborted turn discards whatever was queued behind it; any other
      // completion (success or error) sends the next queued submission.
      if (turnAbortController.signal.aborted) {
        const discarded = state.clearPendingSubmissions();
        if (discarded > 0) {
          state.addMessage(
            roomId,
            "system",
            `Discarded ${discarded} queued message${discarded === 1 ? "" : "s"}.`,
          );
        }
      } else {
        const next = state.takeNextPendingSubmission();
        if (next !== undefined) {
          // New microtask: don't run the next turn inside this finally block.
          // handleSendMessage never rejects (it catches everything), so void
          // is safe here.
          queueMicrotask(() => {
            void this.handleSendMessage(next);
          });
        }
      }
      this.tui.requestRender();
    }
  }
}

/** One-line, length-capped echo of a queued submission for the system notice. */
function submissionPreview(text: string, maxLength = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return err.name === "AbortError";
  }
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === "AbortError" || /\babort(?:ed)?\b/i.test(err.message);
}
