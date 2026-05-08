import type { AgentRuntime } from "@elizaos/core";
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
import { FilteringTerminal } from "./lib/filtering-terminal.js";
import { getAgentClient } from "./lib/agent-client.js";
import { getCwd, setCwd } from "./lib/cwd.js";
import { getCodeTaskService } from "./lib/get-code-task-service.js";
import { useStore } from "./lib/store.js";

// handleTaskSlashCommand was removed with the legacy orchestrator service.
// The /task slash command handler below is a stub until task management is rewired.
async function handleTaskSlashCommand(
  _args: string,
  _deps: Record<string, unknown>,
): Promise<boolean> {
  return false;
}

import type { CodeTask, SubAgentType, TaskEvent } from "./types.js";

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

// Slash command autocomplete items
const SLASH_COMMANDS: AutocompleteItem[] = [
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
  private running = false;
  private initialized = false;
  private exitResolver: (() => void) | null = null;

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
    this.running = true;

    await useStore.getState().loadSessionState();
    this.initialized = true;

    this.initializeManagers();

    await this.checkInterruptedTasks();

    this.tui.start();

    await new Promise<void>((resolve) => {
      this.exitResolver = resolve;
    });
  }

  stop(): void {
    this.running = false;
    this.tui.stop();
    if (this.exitResolver) {
      this.exitResolver();
      this.exitResolver = null;
    }
  }

  private initializeManagers(): void {
    const agentClient = getAgentClient();
    agentClient.setRuntime(this.runtime);

    // Get task service and sync tasks to UI
    const service = getCodeTaskService(this.runtime);
    if (service) {
      const state = useStore.getState();
      const storedTaskId = state.currentTaskId;

      // Initial sync
      service.getTasks().then((tasks: CodeTask[]) => {
        useStore.getState().setTasks(tasks);

        if (
          storedTaskId &&
          tasks.some((t) => t.id === storedTaskId)
        ) {
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
    if (this.showingHelp) {
      if (data === "?" || data === "\x1b" || data === "\x08") {
        this.closeHelp();
      }
      return true;
    }

    if (data === "?") {
      this.openHelp();
      return true;
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

    if (data === "\x1b[1;5D" || data === ",") {
      useStore.getState().adjustTaskPaneWidth(-0.05);
      this.tui.requestRender();
      return true;
    }
    if (data === "\x1b[1;5C" || data === ".") {
      useStore.getState().adjustTaskPaneWidth(0.05);
      this.tui.requestRender();
      return true;
    }

    return false;
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
            `Active agent: ${state.selectedSubAgentType ?? "(not set)"}\n\nUsage: /agent <type>\nTypes:\n- eliza\n- claude-code\n- codex\n- opencode\n- sweagent\n- elizaos-native`,
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
            `Unknown agent type: "${typeRaw}". Try: eliza, claude-code, codex, opencode, sweagent, elizaos-native`,
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
    }

    state.setLoading(true);
    state.setAgentTyping(true);
    this.tui.requestRender();

    try {
      const roomId = state.currentRoomId;
      const room = state.rooms.find((r) => r.id === roomId);
      if (!room) {
        throw new Error("Current conversation not found");
      }

      state.addMessage(roomId, "user", text);
      this.tui.requestRender();

      const agentClient = getAgentClient();
      const placeholder = state.addMessage(roomId, "assistant", "", undefined);
      await agentClient.sendMessage({
        room,
        text,
        identity: state.identity,
        onDelta: (delta) => {
          state.appendToMessage(roomId, placeholder.id, delta);
          this.tui.requestRender();
        },
      });

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
    } finally {
      state.setLoading(false);
      state.setAgentTyping(false);
      this.tui.requestRender();
    }
  }
}
