import { beforeEach, describe, expect, test } from "vitest";
import {
  selectCurrentRoom,
  selectMessages,
  selectTaskStats,
  useStore,
} from "../lib/store.js";
import type { ChatRoom, CodeTask, UUID } from "../types.js";

// ============================================================================
// Test Helpers
// ============================================================================

function resetStore() {
  // Reset store to initial state
  useStore.setState({
    rooms: [
      {
        id: "default-main-room",
        name: "Main",
        messages: [],
        createdAt: new Date(),
        taskIds: [],
        elizaRoomId: "main-room-uuid" as UUID,
      },
    ],
    currentRoomId: "default-main-room",
    tasks: [],
    currentTaskId: null,
    focusedPane: "chat",
    showFinishedTasks: false,
    taskPaneVisibility: "auto",
    taskPaneWidthFraction: 0.4,
    isLoading: false,
    inputValue: "",
    isAgentTyping: false,
    // Keep disabled in unit tests to avoid debounced session writes.
    sessionLoaded: false,
  });
}

function createMockTask(overrides: Partial<CodeTask> = {}): CodeTask {
  return {
    id: `task-${Date.now()}`,
    name: "Test Task",
    description: "A test task",
    roomId: "room-1" as UUID,
    worldId: "world-1" as UUID,
    tags: [],
    metadata: {
      status: "pending",
      progress: 0,
      output: [],
      steps: [],
      workingDirectory: "/test",
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

// ============================================================================
// Room Management Tests
// ============================================================================

describe("Room Management", () => {
  beforeEach(resetStore);

  test("should have initial room on creation", () => {
    const state = useStore.getState();
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0].name).toBe("Main");
    expect(state.currentRoomId).toBe("default-main-room");
  });

  test("should create a new room", () => {
    const { createRoom } = useStore.getState();
    const newRoom = createRoom("Test Room");

    const state = useStore.getState();
    expect(state.rooms).toHaveLength(2);
    expect(newRoom.name).toBe("Test Room");
    expect(state.currentRoomId).toBe(newRoom.id);
  });

  test("should switch rooms", () => {
    const { createRoom, switchRoom } = useStore.getState();
    const room1 = useStore.getState().rooms[0];
    const room2 = createRoom("Room 2");

    expect(useStore.getState().currentRoomId).toBe(room2.id);

    switchRoom(room1.id);
    expect(useStore.getState().currentRoomId).toBe(room1.id);
  });

  test("should not switch to non-existent room", () => {
    const { switchRoom } = useStore.getState();
    const originalRoomId = useStore.getState().currentRoomId;

    switchRoom("non-existent-room");
    expect(useStore.getState().currentRoomId).toBe(originalRoomId);
  });

  test("should delete room", () => {
    const { createRoom, deleteRoom } = useStore.getState();
    const room2 = createRoom("Room 2");

    expect(useStore.getState().rooms).toHaveLength(2);

    deleteRoom(room2.id);
    expect(useStore.getState().rooms).toHaveLength(1);
  });

  test("should not delete last room", () => {
    const { deleteRoom } = useStore.getState();
    const mainRoom = useStore.getState().rooms[0];

    deleteRoom(mainRoom.id);
    expect(useStore.getState().rooms).toHaveLength(1);
  });

  test("should switch to another room when current is deleted", () => {
    const { createRoom, deleteRoom } = useStore.getState();
    const mainRoom = useStore.getState().rooms[0];
    const room2 = createRoom("Room 2");

    expect(useStore.getState().currentRoomId).toBe(room2.id);

    deleteRoom(room2.id);
    expect(useStore.getState().currentRoomId).toBe(mainRoom.id);
  });
});

// ============================================================================
// Message Management Tests
// ============================================================================

describe("Message Management", () => {
  beforeEach(resetStore);

  test("should add message to room", () => {
    const { addMessage, currentRoomId } = useStore.getState();
    const message = addMessage(currentRoomId, "user", "Hello!");

    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === currentRoomId);
    expect(room?.messages).toHaveLength(1);
    expect(message.content).toBe("Hello!");
    expect(message.role).toBe("user");
  });

  test("should add multiple messages", () => {
    const { addMessage, currentRoomId } = useStore.getState();
    addMessage(currentRoomId, "user", "Hello!");
    addMessage(currentRoomId, "assistant", "Hi there!");
    addMessage(currentRoomId, "system", "System message");

    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === currentRoomId);
    expect(room?.messages).toHaveLength(3);
  });

  test("should clear messages from room", () => {
    const { addMessage, clearMessages, currentRoomId } = useStore.getState();
    addMessage(currentRoomId, "user", "Hello!");
    addMessage(currentRoomId, "assistant", "Hi!");

    clearMessages(currentRoomId);

    const state = useStore.getState();
    const room = state.rooms.find((r) => r.id === currentRoomId);
    expect(room?.messages).toHaveLength(0);
  });

  test("should add message with taskId", () => {
    const { addMessage, currentRoomId } = useStore.getState();
    const message = addMessage(
      currentRoomId,
      "assistant",
      "Task output",
      "task-123",
    );

    expect(message.taskId).toBe("task-123");
  });

  test("should generate unique message IDs", () => {
    const { addMessage, currentRoomId } = useStore.getState();
    const msg1 = addMessage(currentRoomId, "user", "First");
    const msg2 = addMessage(currentRoomId, "user", "Second");

    expect(msg1.id).not.toBe(msg2.id);
  });
});

// ============================================================================
// Task Management Tests
// ============================================================================

describe("Task Management", () => {
  beforeEach(resetStore);

  test("should set tasks", () => {
    const { setTasks } = useStore.getState();
    const tasks = [
      createMockTask({ id: "task-1" }),
      createMockTask({ id: "task-2" }),
    ];

    setTasks(tasks);

    expect(useStore.getState().tasks).toHaveLength(2);
  });

  test("should update task in store", () => {
    const { setTasks, updateTaskInStore } = useStore.getState();
    const task = createMockTask({ id: "task-1", name: "Original" });
    setTasks([task]);

    updateTaskInStore("task-1", { name: "Updated" });

    const state = useStore.getState();
    expect(state.tasks[0].name).toBe("Updated");
  });

  test("should set current task ID", () => {
    const { setTasks, setCurrentTaskId } = useStore.getState();
    const task = createMockTask({ id: "task-1" });
    setTasks([task]);

    setCurrentTaskId("task-1");
    expect(useStore.getState().currentTaskId).toBe("task-1");
  });

  test("should clear current task ID", () => {
    const { setCurrentTaskId } = useStore.getState();
    setCurrentTaskId("task-1");
    setCurrentTaskId(null);

    expect(useStore.getState().currentTaskId).toBeNull();
  });
});

// ============================================================================
// UI State Tests
// ============================================================================

describe("UI State", () => {
  beforeEach(resetStore);

  test("should toggle pane focus", () => {
    const { togglePane } = useStore.getState();

    expect(useStore.getState().focusedPane).toBe("chat");

    togglePane();
    expect(useStore.getState().focusedPane).toBe("tasks");

    togglePane();
    expect(useStore.getState().focusedPane).toBe("chat");
  });

  test("auto task pane visibility should show when focused on tasks even with no open tasks", () => {
    const state = useStore.getState();
    expect(state.taskPaneVisibility).toBe("auto");
    expect(state.tasks).toHaveLength(0);

    // In chat focus with no tasks, auto should hide.
    expect(state.isTaskPaneVisible()).toBe(false);

    // Switch focus to tasks: auto should show so the user can view empty state / finished tasks.
    state.togglePane();
    expect(useStore.getState().focusedPane).toBe("tasks");
    expect(useStore.getState().isTaskPaneVisible()).toBe(true);
  });

  test("should set focused pane directly", () => {
    const { setFocusedPane } = useStore.getState();

    setFocusedPane("tasks");
    expect(useStore.getState().focusedPane).toBe("tasks");

    setFocusedPane("chat");
    expect(useStore.getState().focusedPane).toBe("chat");
  });

  test("should set loading state", () => {
    const { setLoading } = useStore.getState();

    setLoading(true);
    expect(useStore.getState().isLoading).toBe(true);

    setLoading(false);
    expect(useStore.getState().isLoading).toBe(false);
  });

  test("should set agent typing state", () => {
    const { setAgentTyping } = useStore.getState();

    setAgentTyping(true);
    expect(useStore.getState().isAgentTyping).toBe(true);

    setAgentTyping(false);
    expect(useStore.getState().isAgentTyping).toBe(false);
  });

  test("should set input value", () => {
    const { setInputValue } = useStore.getState();

    setInputValue("Hello, world!");
    expect(useStore.getState().inputValue).toBe("Hello, world!");

    setInputValue("");
    expect(useStore.getState().inputValue).toBe("");
  });
});

// ============================================================================
// Selector Tests
// ============================================================================

describe("Selectors", () => {
  beforeEach(resetStore);

  test("selectCurrentRoom should return current room", () => {
    const state = useStore.getState();
    const room = selectCurrentRoom(state);

    expect(room).toBeDefined();
    expect(room?.id).toBe(state.currentRoomId);
  });

  test("selectMessages should return current room messages", () => {
    const { addMessage, currentRoomId } = useStore.getState();
    addMessage(currentRoomId, "user", "Test message");

    const state = useStore.getState();
    const messages = selectMessages(state);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Test message");
  });

  test("selectMessages should return empty array for no messages", () => {
    const state = useStore.getState();
    const messages = selectMessages(state);

    expect(messages).toEqual([]);
  });

  test("selectTaskStats should calculate task statistics", () => {
    const { setTasks } = useStore.getState();
    setTasks([
      createMockTask({
        id: "1",
        metadata: {
          status: "running",
          progress: 50,
          output: [],
          steps: [],
          workingDirectory: "/",
          createdAt: Date.now(),
        },
      }),
      createMockTask({
        id: "2",
        metadata: {
          status: "running",
          progress: 30,
          output: [],
          steps: [],
          workingDirectory: "/",
          createdAt: Date.now(),
        },
      }),
      createMockTask({
        id: "3",
        metadata: {
          status: "completed",
          progress: 100,
          output: [],
          steps: [],
          workingDirectory: "/",
          createdAt: Date.now(),
        },
      }),
      createMockTask({
        id: "4",
        metadata: {
          status: "failed",
          progress: 0,
          output: [],
          steps: [],
          workingDirectory: "/",
          createdAt: Date.now(),
        },
      }),
      createMockTask({
        id: "5",
        metadata: {
          status: "pending",
          progress: 0,
          output: [],
          steps: [],
          workingDirectory: "/",
          createdAt: Date.now(),
        },
      }),
    ]);

    const state = useStore.getState();
    const stats = selectTaskStats(state);

    expect(stats.total).toBe(5);
    expect(stats.running).toBe(2);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
  });

  test("selectTaskStats should handle empty tasks", () => {
    const state = useStore.getState();
    const stats = selectTaskStats(state);

    expect(stats.total).toBe(0);
    expect(stats.running).toBe(0);
    expect(stats.completed).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.pending).toBe(0);
  });
});

// ============================================================================
// Getter Tests
// ============================================================================

describe("Getters", () => {
  beforeEach(resetStore);

  test("getCurrentRoom should return current room", () => {
    const { getCurrentRoom } = useStore.getState();
    const room = getCurrentRoom();

    expect(room).toBeDefined();
    expect(room.id).toBe("default-main-room");
  });

  test("getCurrentTask should return null when no task selected", () => {
    const { getCurrentTask } = useStore.getState();
    const task = getCurrentTask();

    expect(task).toBeNull();
  });

  test("getCurrentTask should return selected task", () => {
    const { setTasks, setCurrentTaskId, getCurrentTask } = useStore.getState();
    const mockTask = createMockTask({ id: "task-1", name: "My Task" });
    setTasks([mockTask]);
    setCurrentTaskId("task-1");

    const task = getCurrentTask();
    expect(task).toBeDefined();
    expect(task?.name).toBe("My Task");
  });
});

// ============================================================================
// Session State Tests
// ============================================================================

describe("Session State", () => {
  beforeEach(resetStore);

  test("should track sessionLoaded state", () => {
    expect(useStore.getState().sessionLoaded).toBe(false);

    useStore.setState({ sessionLoaded: true });
    expect(useStore.getState().sessionLoaded).toBe(true);

    useStore.setState({ sessionLoaded: false });
    expect(useStore.getState().sessionLoaded).toBe(false);
  });

  test("restoreSession should restore rooms and state", () => {
    const { restoreSession } = useStore.getState();
    const testRoom: ChatRoom = {
      id: "restored-room",
      name: "Restored",
      messages: [],
      createdAt: new Date(),
      taskIds: [],
      elizaRoomId: "eliza-123" as UUID,
    };

    restoreSession({
      rooms: [testRoom],
      currentRoomId: "restored-room",
      currentTaskId: "task-123",
      cwd: "/restored/path",
    });

    const state = useStore.getState();
    expect(state.rooms).toHaveLength(1);
    expect(state.rooms[0].name).toBe("Restored");
    expect(state.currentRoomId).toBe("restored-room");
    expect(state.currentTaskId).toBe("task-123");
  });

  test("restoreSession should validate room structure", () => {
    const { restoreSession } = useStore.getState();
    const initialRooms = useStore.getState().rooms;

    // Try to restore with invalid room (missing required fields)
    restoreSession({
      rooms: [{ id: "bad" } as ChatRoom],
      currentRoomId: "bad",
      currentTaskId: null,
      cwd: "/",
    });

    // Should keep initial rooms since restored rooms are invalid
    const state = useStore.getState();
    expect(state.rooms).toEqual(initialRooms);
  });
});
