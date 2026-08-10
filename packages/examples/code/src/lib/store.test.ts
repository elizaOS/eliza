/** Exercises room, message, task, pane, and submission transitions in the Code example store. */
import { beforeEach, describe, expect, it } from "bun:test";
import { stringToUuid } from "@elizaos/core";
import type { CodeTask } from "../types.js";
import { useStore } from "./store.js";

function task(name: string): CodeTask {
  return {
    id: stringToUuid(`task:${name}`),
    name,
    metadata: {
      status: "pending",
      progress: 0,
      output: [],
      steps: [],
      workingDirectory: "/tmp",
      createdAt: 1,
    },
  };
}

beforeEach(() => {
  process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE = "1";
  useStore.setState({
    rooms: [],
    currentRoomId: "missing",
    tasks: [],
    currentTaskId: null,
    focusedPane: "chat",
    showFinishedTasks: false,
    taskPaneVisibility: "hidden",
    taskPaneWidthFraction: 0.4,
    pendingSubmissions: [],
    sessionLoaded: false,
  });
});

describe("store transitions", () => {
  it("manages rooms and message content", () => {
    const first = useStore.getState().createRoom("First");
    const second = useStore.getState().createRoom("Second");
    useStore.getState().switchRoom(first.id);
    const message = useStore.getState().addMessage(first.id, "assistant", "a");
    useStore.getState().appendToMessage(first.id, message.id, "b");
    useStore.getState().setMessageContent(first.id, message.id, "final");
    expect(useStore.getState().getCurrentRoom().id).toBe(first.id);
    expect(useStore.getState().rooms[0].messages[0].content).toBe("final");
    useStore.getState().clearMessages(first.id);
    useStore.getState().deleteRoom(first.id);
    expect(useStore.getState().currentRoomId).toBe(second.id);
  });

  it("updates tasks and derives task-pane visibility", () => {
    const first = task("first");
    const second = task("second");
    useStore.getState().setTasks([first, second]);
    useStore.getState().setCurrentTaskId(first.id ?? null);
    useStore.getState().updateTaskInStore(first.id ?? "", { name: "renamed" });
    expect(useStore.getState().getCurrentTask()?.name).toBe("renamed");
    useStore.getState().setTaskPaneVisibility("shown");
    useStore.getState().setFocusedPane("tasks");
    expect(useStore.getState().isTaskPaneVisible()).toBe(true);
    useStore.getState().togglePane();
    expect(useStore.getState().focusedPane).toBe("chat");
    useStore.getState().setTaskPaneWidthFraction(1);
    useStore.getState().adjustTaskPaneWidth(-1);
    expect(useStore.getState().taskPaneWidthFraction).toBe(0.2);
    useStore.getState().setTasks([second]);
    expect(useStore.getState().currentTaskId).toBeNull();
  });

  it("tracks UI controls and drains queued submissions in FIFO order", () => {
    const state = useStore.getState();
    state.setInputValue("draft");
    state.setAgentTyping(true);
    state.setLoading(true);
    state.setSelectedSubAgentType("codex");
    state.toggleShowFinishedTasks();
    expect(state.enqueuePendingSubmission("one")).toBe(1);
    expect(state.enqueuePendingSubmission("two")).toBe(2);
    expect(useStore.getState().takeNextPendingSubmission()).toBe("one");
    expect(useStore.getState().clearPendingSubmissions()).toBe(1);
    expect(useStore.getState()).toMatchObject({
      inputValue: "draft",
      isAgentTyping: true,
      isLoading: true,
      selectedSubAgentType: "codex",
      showFinishedTasks: true,
    });
  });
});
