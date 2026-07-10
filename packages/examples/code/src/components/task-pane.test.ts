/** Exercises task-list rendering and keyboard state transitions through the real TUI host. */
import { beforeEach, describe, expect, it } from "bun:test";
import { type AgentRuntime, stringToUuid } from "@elizaos/core";
import { TUI } from "@elizaos/tui";
import { useStore } from "../lib/store.js";
import { VirtualTerminal } from "../testing/virtual-terminal.test.js";
import type { CodeTask } from "../types.js";
import { TaskPane } from "./TaskPane.js";

function codeTask(): CodeTask {
  return {
    id: stringToUuid("task-pane:test"),
    name: "Build feature",
    metadata: {
      status: "running",
      progress: 50,
      output: ["🔧 running tool", "✅ complete"],
      steps: [],
      workingDirectory: "/tmp",
      createdAt: 1,
      subAgentType: "codex",
      trace: [
        { kind: "note", level: "warning", message: "check", ts: 1, seq: 1 },
        {
          kind: "llm",
          iteration: 1,
          modelType: "text",
          response: "answer",
          responsePreview: "answer",
          ts: 2,
          seq: 2,
        },
        {
          kind: "tool_call",
          iteration: 1,
          name: "shell",
          args: {},
          ts: 3,
          seq: 3,
        },
        {
          kind: "tool_result",
          iteration: 1,
          name: "shell",
          success: true,
          output: "ok",
          outputPreview: "ok",
          ts: 4,
          seq: 4,
        },
        { kind: "status", status: "paused", message: "waiting", ts: 5, seq: 5 },
      ],
    },
  };
}

function pane(): TaskPane {
  const terminal = new VirtualTerminal();
  const tui = new TUI(terminal);
  const runtime = { getService: () => null } as unknown as AgentRuntime;
  return new TaskPane({ runtime, tui });
}

beforeEach(() => {
  process.env.ELIZA_CODE_DISABLE_SESSION_PERSISTENCE = "1";
  useStore.setState({
    tasks: [],
    currentTaskId: null,
    focusedPane: "chat",
    showFinishedTasks: false,
    taskPaneVisibility: "shown",
    pendingSubmissions: [],
  });
});

describe("TaskPane", () => {
  it("distinguishes empty, output, and trace views", () => {
    const component = pane();
    expect(component.renderContent(80, 24).join("\n")).toContain("No tasks.");

    const task = codeTask();
    useStore.getState().setTasks([task]);
    useStore.getState().setCurrentTaskId(task.id ?? null);
    component.syncFocus(true);
    const output = component.renderContent(80, 24).join("\n");
    expect(output).toContain("Build feature");
    expect(output).toContain("running tool");
    expect(output).toContain("50%");

    component.handleInput("t");
    const trace = component.renderContent(80, 24).join("\n");
    expect(trace).toContain("LLM iter 1");
    expect(trace).toContain("RESULT: shell");
  });

  it("handles navigation and local display controls", () => {
    const component = pane();
    const task = codeTask();
    useStore
      .getState()
      .setTasks([
        task,
        { ...task, id: stringToUuid("task-pane:second"), name: "Second" },
      ]);
    component.syncFocus(true);
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(useStore.getState().getCurrentTask()?.name).toBe("Second");
    component.handleInput("f");
    component.handleInput("e");
    component.handleInput("\x1b[1;5A");
    component.handleInput("\x1b[1;5B");
    expect(useStore.getState().showFinishedTasks).toBe(true);
    expect(component.renderContent(60, 18).join("\n")).toContain("[edit]");
    component.syncFocus(false);
    expect(component.isFocused()).toBe(false);
  });
});
