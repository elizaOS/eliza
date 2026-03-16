import { stringToUuid } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";
import type {
  ChatRoom,
  CodeTask,
  Message,
  PaneFocus,
  SubAgentType,
  TaskPaneVisibility,
  TaskUserStatus,
} from "../types.js";
import { getCwd, setCwd } from "./cwd.js";
import {
  createRoomElizaId,
  ensureSessionIdentity,
  getMainRoomElizaId,
  isUuidString,
  type SessionIdentity,
} from "./identity.js";
import { loadSession, type SessionState, saveSession } from "./session.js";

function shouldPersistSessionToDisk(): boolean {
  if (process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE === "1") return false;
  if (process.env.BUN_TEST === "1") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

function getTaskUserStatus(
  userStatus: TaskUserStatus | undefined,
): TaskUserStatus {
  return userStatus ?? "open";
}

function hasOpenTasks(tasks: CodeTask[]): boolean {
  return tasks.some(
    (t) => getTaskUserStatus(t.metadata?.userStatus) !== "done",
  );
}

function computeTaskPaneVisible(
  visibility: TaskPaneVisibility,
  tasks: CodeTask[],
  focusedPane: PaneFocus,
): boolean {
  if (visibility === "shown") return true;
  if (visibility === "hidden") return false;
  // auto: show when there are open tasks OR when the user is actively focused on the task pane
  return hasOpenTasks(tasks) || focusedPane === "tasks";
}

// ============================================================================
// Store State Interface
// ============================================================================

interface ElizaCodeState {
  // Identity (persisted per-project)
  identity: SessionIdentity;

  // Rooms
  rooms: ChatRoom[];
  currentRoomId: string;

  // Tasks (synced from CodeTaskService)
  tasks: CodeTask[];
  currentTaskId: string | null;
  /** Selected worker type for new tasks (/agent). */
  selectedSubAgentType: SubAgentType | null;

  // UI State
  focusedPane: PaneFocus;
  /** Whether to include finished tasks (userStatus=done) in the task list. */
  showFinishedTasks: boolean;
  taskPaneVisibility: TaskPaneVisibility;
  /** Preferred task pane width as a fraction of terminal width (0-1). */
  taskPaneWidthFraction: number;
  isLoading: boolean;
  inputValue: string;
  isAgentTyping: boolean;

  // Session initialized flag
  sessionLoaded: boolean;

  // Room Actions
  createRoom: (name: string) => ChatRoom;
  switchRoom: (roomId: string) => void;
  deleteRoom: (roomId: string) => void;

  // Message Actions
  addMessage: (
    roomId: string,
    role: Message["role"],
    content: string,
    taskId?: string,
  ) => Message;
  /** Append text to an existing message (used for streaming). No-op if not found. */
  appendToMessage: (roomId: string, messageId: string, delta: string) => void;
  /** Replace message content (used for streaming finalization). No-op if not found. */
  setMessageContent: (
    roomId: string,
    messageId: string,
    content: string,
  ) => void;
  clearMessages: (roomId: string) => void;

  // Task Actions (for UI sync - actual data managed by CodeTaskService)
  setTasks: (tasks: CodeTask[]) => void;
  updateTaskInStore: (taskId: string, updates: Partial<CodeTask>) => void;
  setCurrentTaskId: (taskId: string | null) => void;
  setSelectedSubAgentType: (type: SubAgentType | null) => void;

  // UI Actions
  setFocusedPane: (pane: PaneFocus) => void;
  togglePane: () => void;
  setShowFinishedTasks: (show: boolean) => void;
  toggleShowFinishedTasks: () => void;
  setTaskPaneVisibility: (visibility: TaskPaneVisibility) => void;
  setTaskPaneWidthFraction: (fraction: number) => void;
  adjustTaskPaneWidth: (deltaFraction: number) => void;
  setLoading: (loading: boolean) => void;
  setInputValue: (value: string) => void;
  setAgentTyping: (typing: boolean) => void;

  // Session Actions
  loadSessionState: () => Promise<void>;
  saveSessionState: () => Promise<void>;
  restoreSession: (state: SessionState) => void;

  // Getters
  getCurrentRoom: () => ChatRoom;
  getCurrentTask: () => CodeTask | null;
  isTaskPaneVisible: () => boolean;
}

// ============================================================================
// Initial State
// ============================================================================

const INITIAL_ROOM_ID = "default-main-room";

const initialIdentity = ensureSessionIdentity();

const createInitialRoom = (identity: SessionIdentity): ChatRoom => ({
  id: INITIAL_ROOM_ID,
  name: "Main",
  messages: [],
  createdAt: new Date(),
  taskIds: [],
  elizaRoomId: getMainRoomElizaId(identity),
});

const initialRoom = createInitialRoom(initialIdentity);

// Debounced save - prevents excessive writes during rapid state changes
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let isSaving = false;

const debouncedSave = (state: ElizaCodeState) => {
  // Don't queue saves while already saving or before session is loaded
  if (!shouldPersistSessionToDisk()) return;
  if (isSaving || !state.sessionLoaded) return;

  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    isSaving = true;
    try {
      await state.saveSessionState();
    } finally {
      isSaving = false;
    }
  }, 1000);
};

// ============================================================================
// Store Implementation
// ============================================================================

export const useStore = create<ElizaCodeState>((set, get) => ({
  // Initial state
  identity: initialIdentity,
  rooms: [initialRoom],
  currentRoomId: initialRoom.id,
  tasks: [],
  currentTaskId: null,
  selectedSubAgentType: null,
  focusedPane: "chat",
  showFinishedTasks: false,
  taskPaneVisibility: "auto",
  taskPaneWidthFraction: 0.4,
  isLoading: false,
  inputValue: "",
  isAgentTyping: false,
  sessionLoaded: false,

  // Room Actions
  createRoom: (name: string) => {
    const identity = get().identity;
    const room: ChatRoom = {
      id: uuidv4(),
      name,
      messages: [],
      createdAt: new Date(),
      taskIds: [],
      elizaRoomId: createRoomElizaId(identity),
    };

    set((state) => ({
      rooms: [...state.rooms, room],
      currentRoomId: room.id,
    }));

    debouncedSave(get());
    return room;
  },

  switchRoom: (roomId: string) => {
    const state = get();
    if (state.rooms.some((r) => r.id === roomId)) {
      set({ currentRoomId: roomId });
      debouncedSave(get());
    }
  },

  deleteRoom: (roomId: string) => {
    const state = get();
    if (state.rooms.length <= 1) return;
    if (roomId === state.currentRoomId) {
      const otherRoom = state.rooms.find((r) => r.id !== roomId);
      if (otherRoom) {
        set({ currentRoomId: otherRoom.id });
      }
    }
    set((state) => ({
      rooms: state.rooms.filter((r) => r.id !== roomId),
    }));
    debouncedSave(get());
  },

  // Message Actions
  addMessage: (
    roomId: string,
    role: Message["role"],
    content: string,
    taskId?: string,
  ) => {
    const message: Message = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date(),
      roomId,
      taskId,
    };

    set((state) => ({
      rooms: state.rooms.map((room) =>
        room.id === roomId
          ? { ...room, messages: [...room.messages, message] }
          : room,
      ),
    }));

    debouncedSave(get());
    return message;
  },

  appendToMessage: (roomId: string, messageId: string, delta: string) => {
    if (!delta) return;
    set((state) => ({
      rooms: state.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const nextMessages = room.messages.map((m) =>
          m.id === messageId ? { ...m, content: `${m.content}${delta}` } : m,
        );
        return { ...room, messages: nextMessages };
      }),
    }));
    debouncedSave(get());
  },

  setMessageContent: (roomId: string, messageId: string, content: string) => {
    set((state) => ({
      rooms: state.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const nextMessages = room.messages.map((m) =>
          m.id === messageId ? { ...m, content } : m,
        );
        return { ...room, messages: nextMessages };
      }),
    }));
    debouncedSave(get());
  },

  clearMessages: (roomId: string) => {
    set((state) => ({
      rooms: state.rooms.map((room) =>
        room.id === roomId ? { ...room, messages: [] } : room,
      ),
    }));
    debouncedSave(get());
  },

  // Task Actions (UI sync)
  setTasks: (tasks: CodeTask[]) => {
    let clearedCurrent = false;
    set((state) => {
      const hasCurrent =
        state.currentTaskId !== null &&
        tasks.some((t) => t.id === state.currentTaskId);
      const nextCurrentTaskId = hasCurrent ? state.currentTaskId : null;
      if (state.currentTaskId !== null && nextCurrentTaskId === null) {
        clearedCurrent = true;
      }
      return { tasks, currentTaskId: nextCurrentTaskId };
    });

    if (clearedCurrent) {
      debouncedSave(get());
    }
  },

  updateTaskInStore: (taskId: string, updates: Partial<CodeTask>) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, ...updates } : task,
      ),
    }));
  },

  setCurrentTaskId: (taskId: string | null) => {
    set({ currentTaskId: taskId });
    debouncedSave(get());
  },

  setSelectedSubAgentType: (type: SubAgentType | null) => {
    set({ selectedSubAgentType: type });
    debouncedSave(get());
  },

  // UI Actions
  setFocusedPane: (pane: PaneFocus) => {
    set((state) => {
      // Respect explicit pane hiding: do not allow focusing a hidden pane.
      if (pane === "tasks" && state.taskPaneVisibility === "hidden") {
        return { focusedPane: "chat" };
      }
      return { focusedPane: pane };
    });
    debouncedSave(get());
  },

  togglePane: () => {
    set((state) => {
      if (state.focusedPane === "chat") {
        if (state.taskPaneVisibility === "hidden") {
          return state;
        }
        return { focusedPane: "tasks" };
      }
      return { focusedPane: "chat" };
    });
    debouncedSave(get());
  },

  setShowFinishedTasks: (show: boolean) => {
    set({ showFinishedTasks: show });
    debouncedSave(get());
  },

  toggleShowFinishedTasks: () => {
    set((state) => ({ showFinishedTasks: !state.showFinishedTasks }));
    debouncedSave(get());
  },

  setTaskPaneVisibility: (visibility: TaskPaneVisibility) => {
    set((state) => {
      const visible = computeTaskPaneVisible(
        visibility,
        state.tasks,
        state.focusedPane,
      );
      if (!visible && state.focusedPane === "tasks") {
        return { taskPaneVisibility: visibility, focusedPane: "chat" };
      }
      return { taskPaneVisibility: visibility };
    });
    debouncedSave(get());
  },

  setTaskPaneWidthFraction: (fraction: number) => {
    const clamped = Math.max(0.2, Math.min(0.75, fraction));
    set({ taskPaneWidthFraction: clamped });
    debouncedSave(get());
  },

  adjustTaskPaneWidth: (deltaFraction: number) => {
    set((state) => {
      const next = Math.max(
        0.2,
        Math.min(0.75, state.taskPaneWidthFraction + deltaFraction),
      );
      return { taskPaneWidthFraction: next };
    });
    debouncedSave(get());
  },

  setLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },

  setInputValue: (value: string) => {
    set({ inputValue: value });
  },

  setAgentTyping: (typing: boolean) => {
    set({ isAgentTyping: typing });
  },

  // Session Actions
  loadSessionState: async () => {
    let restored = false;
    try {
      const session = await loadSession();
      if (session?.rooms && session.rooms.length > 0) {
        get().restoreSession(session);
        restored = true;
      }
    } catch {
      // Ignore session load errors - will use initial state
    }
    // Mark session as loaded regardless of success
    set({ sessionLoaded: true });

    // If this is a fresh session (no file yet), persist immediately so identity + room IDs
    // remain stable across restarts.
    if (!restored && shouldPersistSessionToDisk()) {
      try {
        await get().saveSessionState();
      } catch {
        // ignore
      }
    }
  },

  saveSessionState: async () => {
    const state = get();
    await saveSession({
      rooms: state.rooms,
      currentRoomId: state.currentRoomId,
      currentTaskId: state.currentTaskId,
      cwd: getCwd(),
      identity: state.identity,
      selectedSubAgentType: state.selectedSubAgentType,
      focusedPane: state.focusedPane,
      taskPaneVisibility: state.taskPaneVisibility,
      taskPaneWidthFraction: state.taskPaneWidthFraction,
      showFinishedTasks: state.showFinishedTasks,
    });
  },

  restoreSession: (session: SessionState) => {
    // Restore CWD first
    if (session.cwd) {
      setCwd(session.cwd).catch((err: Error) => {
        const msg = err.message;
        console.error(`[store] Failed to restore cwd: ${msg}`);
      });
    }

    // Restore identity (or create defaults for older sessions).
    const identity = ensureSessionIdentity(session.identity);

    // Restore UI settings (with defaults for older sessions).
    const focusedPane: PaneFocus =
      session.focusedPane === "tasks" || session.focusedPane === "chat"
        ? session.focusedPane
        : "chat";
    const taskPaneVisibility: TaskPaneVisibility =
      session.taskPaneVisibility === "shown" ||
      session.taskPaneVisibility === "hidden" ||
      session.taskPaneVisibility === "auto"
        ? session.taskPaneVisibility
        : "auto";
    const taskPaneWidthFraction =
      typeof session.taskPaneWidthFraction === "number"
        ? Math.max(0.2, Math.min(0.75, session.taskPaneWidthFraction))
        : 0.4;
    const showFinishedTasks = session.showFinishedTasks === true;
    const selectedSubAgentType =
      session.selectedSubAgentType === null ||
      session.selectedSubAgentType === undefined ||
      typeof session.selectedSubAgentType === "string"
        ? (session.selectedSubAgentType ?? null)
        : null;

    // Restore the currently-selected worker into process env so runtime actions
    // (e.g., CREATE_TASK) can read it.
    if (selectedSubAgentType) {
      process.env.ELIZA_CODE_ACTIVE_SUB_AGENT = selectedSubAgentType;
    } else {
      delete process.env.ELIZA_CODE_ACTIVE_SUB_AGENT;
    }

    // Validate and restore rooms
    if (
      session.rooms &&
      Array.isArray(session.rooms) &&
      session.rooms.length > 0
    ) {
      // Ensure all rooms have valid structure
      const validRooms = session.rooms
        .filter(
          (room) =>
            room &&
            typeof room.id === "string" &&
            typeof room.name === "string" &&
            Array.isArray(room.messages),
        )
        .map((room) => {
          // Repair invalid persisted room UUIDs (e.g. "main-room-uuid") which break the SQL adapter.
          if (
            typeof room.elizaRoomId === "string" &&
            isUuidString(room.elizaRoomId)
          ) {
            return room;
          }
          const repairedId =
            room.id === INITIAL_ROOM_ID
              ? getMainRoomElizaId(identity)
              : stringToUuid(
                  `eliza-code:room:${identity.projectId}:${room.id}`,
                );
          return { ...room, elizaRoomId: repairedId };
        });

      if (validRooms.length > 0) {
        // Ensure currentRoomId points to a valid room
        const validCurrentRoomId = validRooms.some(
          (r) => r.id === session.currentRoomId,
        )
          ? session.currentRoomId
          : validRooms[0].id;

        set({
          identity,
          rooms: validRooms,
          currentRoomId: validCurrentRoomId,
          currentTaskId: session.currentTaskId,
          selectedSubAgentType,
          focusedPane:
            taskPaneVisibility === "hidden" && focusedPane === "tasks"
              ? "chat"
              : focusedPane,
          taskPaneVisibility,
          taskPaneWidthFraction,
          showFinishedTasks,
        });
      }
    } else {
      // Still update identity even if rooms are invalid, so we can persist stable IDs.
      set({
        identity,
        selectedSubAgentType,
        focusedPane:
          taskPaneVisibility === "hidden" && focusedPane === "tasks"
            ? "chat"
            : focusedPane,
        taskPaneVisibility,
        taskPaneWidthFraction,
        showFinishedTasks,
      });
    }
  },

  // Getters
  getCurrentRoom: () => {
    const state = get();
    const room = state.rooms.find((r) => r.id === state.currentRoomId);
    if (!room) {
      throw new Error("Current room not found");
    }
    return room;
  },

  getCurrentTask: () => {
    const state = get();
    if (!state.currentTaskId) return null;
    return state.tasks.find((t) => t.id === state.currentTaskId) ?? null;
  },

  isTaskPaneVisible: () => {
    const state = get();
    return computeTaskPaneVisible(
      state.taskPaneVisibility,
      state.tasks,
      state.focusedPane,
    );
  },
}));

// ============================================================================
// Selectors
// ============================================================================

export const selectCurrentRoom = (state: ElizaCodeState) =>
  state.rooms.find((r) => r.id === state.currentRoomId);

export const selectCurrentTask = (state: ElizaCodeState) =>
  state.currentTaskId
    ? state.tasks.find((t) => t.id === state.currentTaskId)
    : null;

export const selectMessages = (state: ElizaCodeState) => {
  const room = selectCurrentRoom(state);
  return room?.messages ?? [];
};

export const selectTaskStats = (state: ElizaCodeState) => ({
  total: state.tasks.length,
  running: state.tasks.filter((t) => t.metadata?.status === "running").length,
  completed: state.tasks.filter((t) => t.metadata?.status === "completed")
    .length,
  failed: state.tasks.filter((t) => t.metadata?.status === "failed").length,
  pending: state.tasks.filter((t) => t.metadata?.status === "pending").length,
});

export const selectIsTaskPaneVisible = (state: ElizaCodeState) =>
  computeTaskPaneVisible(
    state.taskPaneVisibility,
    state.tasks,
    state.focusedPane,
  );
