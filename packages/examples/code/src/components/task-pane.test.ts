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

function taskWith(
  key: string,
  overrides: {
    name?: string;
    status?:
      | "pending"
      | "running"
      | "completed"
      | "failed"
      | "paused"
      | "cancelled";
    progress?: number;
    userStatus?: "open" | "done";
    subAgentType?: string;
    error?: string;
    output?: string[];
  } = {},
): CodeTask {
  return {
    id: stringToUuid(`task-pane:${key}`),
    name: overrides.name ?? key,
    metadata: {
      status: overrides.status ?? "pending",
      progress: overrides.progress ?? 0,
      output: overrides.output ?? [],
      steps: [],
      workingDirectory: "/tmp",
      createdAt: 1,
      ...(overrides.userStatus ? { userStatus: overrides.userStatus } : {}),
      ...(overrides.subAgentType
        ? { subAgentType: overrides.subAgentType }
        : {}),
      ...(overrides.error ? { error: overrides.error } : {}),
    },
  };
}

interface ServiceCall {
  method: string;
  args: unknown[];
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recordingService(failing?: string[]) {
  const calls: ServiceCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      if (failing?.includes(method)) {
        return Promise.reject(new Error(`${method} failed`));
      }
      return Promise.resolve();
    };
  return {
    calls,
    createCodeTask: record("createCodeTask"),
    createTask: record("createTask"),
    getCurrentTask: () => Promise.resolve(null),
    getTask: () => Promise.resolve(null),
    getTasks: () => Promise.resolve([]),
    startTaskExecution: record("startTaskExecution"),
    pauseTask: record("pauseTask"),
    resumeTask: record("resumeTask"),
    cancelTask: record("cancelTask"),
    deleteTask: record("deleteTask"),
    renameTask: record("renameTask"),
    appendOutput: record("appendOutput"),
    setCurrentTask: (taskId: string) => {
      calls.push({ method: "setCurrentTask", args: [taskId] });
    },
    getCurrentTaskId: () => null,
    setUserStatus: record("setUserStatus"),
    setTaskSubAgentType: record("setTaskSubAgentType"),
    detectAndPauseInterruptedTasks: () => Promise.resolve([]),
    on: () => {},
  };
}

type RecordingService = ReturnType<typeof recordingService>;

function paneWithService(service: RecordingService): TaskPane {
  const terminal = new VirtualTerminal();
  const tui = new TUI(terminal);
  const runtime = { getService: () => service } as unknown as AgentRuntime;
  return new TaskPane({ runtime, tui });
}

function seedCurrent(_component: TaskPane, task: CodeTask): void {
  useStore.getState().setTasks([task]);
  useStore.getState().setCurrentTaskId(task.id ?? null);
}

function focusedInEditMode(service: RecordingService): {
  component: TaskPane;
  taskId: string;
} {
  const component = paneWithService(service);
  const task = codeTask();
  seedCurrent(component, task);
  component.syncFocus(true);
  component.handleInput("e");
  return { component, taskId: task.id ?? "" };
}

describe("TaskPane focus gating", () => {
  it("ignores every keypress while the pane is unfocused", () => {
    const component = pane();
    useStore.getState().setTasks([codeTask()]);
    component.handleInput("f");
    expect(useStore.getState().showFinishedTasks).toBe(false);
    const rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).toContain("Tab: focus tasks");
    expect(rendered).not.toContain("(all)");
  });

  it("clears edit and confirmation state when focus is lost", () => {
    const service = recordingService();
    const { component } = focusedInEditMode(service);
    component.handleInput("c");
    expect(component.renderContent(80, 24).join("\n")).toContain(
      "Confirm cancel? (y/n)",
    );
    component.syncFocus(false);
    const rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).not.toContain("[edit]");
    expect(rendered).not.toContain("Confirm");
    component.handleInput("y");
    expect(service.calls.map((call) => call.method)).toEqual([]);
  });
});

describe("TaskPane navigation bounds", () => {
  it("clamps up and down movement to the visible range", () => {
    const component = pane();
    const task = codeTask();
    useStore
      .getState()
      .setTasks([
        task,
        { ...task, id: stringToUuid("task-pane:second"), name: "Second" },
      ]);
    component.syncFocus(true);
    component.handleInput("\x1b[A");
    component.handleInput("\r");
    expect(useStore.getState().getCurrentTask()?.name).toBe("Build feature");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    expect(useStore.getState().getCurrentTask()?.name).toBe("Second");
  });

  it("keeps the selection untouched when Enter is pressed with no tasks", () => {
    const component = pane();
    component.syncFocus(true);
    component.handleInput("\r");
    expect(useStore.getState().currentTaskId).toBeNull();
  });
});

describe("TaskPane finished-task filtering", () => {
  it("hides done tasks unless they are current or finished ones are shown", () => {
    const component = pane();
    const open = taskWith("open-one", { name: "Open work" });
    const done = taskWith("done-one", {
      name: "Done work",
      userStatus: "done",
    });
    seedCurrent(component, open);
    useStore.getState().setTasks([open, done]);
    useStore.getState().setCurrentTaskId(open.id ?? null);
    component.syncFocus(true);
    let rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).toContain("Open work");
    expect(rendered).not.toContain("Done work");
    expect(rendered).toContain("(1/2)");
    component.handleInput("f");
    rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).toContain("Done work");
    expect(rendered).toContain("(all)");
  });

  it("keeps a done current task visible without showing others", () => {
    const component = pane();
    const done = taskWith("chosen", { name: "Chosen", userStatus: "done" });
    seedCurrent(component, done);
    component.syncFocus(true);
    const rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).toContain("Chosen");
    expect(rendered).toContain("(1/1)");
  });

  it("reports no open tasks when the only task is done and hidden", () => {
    const component = pane();
    useStore
      .getState()
      .setTasks([taskWith("only", { name: "Only", userStatus: "done" })]);
    component.syncFocus(true);
    expect(component.renderContent(80, 24).join("\n")).toContain(
      "No open tasks.",
    );
  });
});

describe("TaskPane confirmation flows", () => {
  it("cancels the current task only after y is confirmed", async () => {
    const service = recordingService();
    const { component, taskId } = focusedInEditMode(service);
    component.handleInput("c");
    expect(component.renderContent(80, 24).join("\n")).toContain(
      "Confirm cancel? (y/n)",
    );
    component.handleInput("y");
    await flush();
    expect(service.calls.map((call) => call.method)).toEqual(["cancelTask"]);
    expect(service.calls[0]?.args).toEqual([taskId]);
    expect(component.renderContent(80, 24).join("\n")).not.toContain("Confirm");
  });

  it("dismisses cancel and delete prompts without touching the service", () => {
    const service = recordingService();
    const { component } = focusedInEditMode(service);
    component.handleInput("c");
    component.handleInput("n");
    component.handleInput("x");
    component.handleInput("\x1b");
    expect(service.calls).toEqual([]);
    expect(component.renderContent(80, 24).join("\n")).not.toContain("Confirm");
  });

  it("deletes after an uppercase confirmation", async () => {
    const service = recordingService();
    const { component, taskId } = focusedInEditMode(service);
    component.handleInput("x");
    component.handleInput("Y");
    await flush();
    expect(service.calls.map((call) => call.method)).toEqual(["deleteTask"]);
    expect(service.calls[0]?.args).toEqual([taskId]);
  });
});

describe("TaskPane task commands", () => {
  it("toggles user done/open through the service outside edit mode", async () => {
    const service = recordingService();
    const component = paneWithService(service);
    const task = taskWith("toggle", { name: "Toggle me" });
    seedCurrent(component, task);
    component.syncFocus(true);
    component.handleInput("d");
    await flush();
    expect(service.calls.map((call) => call.method)).toEqual(["setUserStatus"]);
    expect(service.calls[0]?.args).toEqual([task.id, "done"]);
    seedCurrent(
      component,
      taskWith("toggle", { name: "Toggle me", userStatus: "done" }),
    );
    component.handleInput("d");
    await flush();
    expect(service.calls.map((call) => call.method)).toEqual([
      "setUserStatus",
      "setUserStatus",
    ]);
    expect(service.calls[1]?.args).toEqual([task.id, "open"]);
  });

  it("cycles sub-agent types with wraparound and unknown fallback", async () => {
    const cases = [
      { current: "codex", next: "elizaos-native" },
      { current: undefined, next: "claude-code" },
      { current: "mystery", next: "claude-code" },
      { current: "elizaos-native", next: "eliza" },
    ];
    for (const item of cases) {
      const service = recordingService();
      const component = paneWithService(service);
      const task = taskWith("cycle", {
        name: "Cycle",
        status: "running",
        subAgentType: item.current,
      });
      seedCurrent(component, task);
      component.syncFocus(true);
      component.handleInput("e");
      component.handleInput("a");
      await flush();
      expect(service.calls.map((call) => call.method)).toEqual([
        "setTaskSubAgentType",
      ]);
      expect(service.calls[0]?.args).toEqual([task.id, item.next]);
    }
  });

  it("pauses running tasks and resumes paused or pending ones", async () => {
    const running = recordingService();
    const runningPane = paneWithService(running);
    seedCurrent(runningPane, taskWith("p1", { name: "P1", status: "running" }));
    runningPane.syncFocus(true);
    runningPane.handleInput("e");
    runningPane.handleInput("p");
    await flush();
    expect(running.calls.map((call) => call.method)).toEqual(["pauseTask"]);

    const paused = recordingService();
    const pausedPane = paneWithService(paused);
    seedCurrent(pausedPane, taskWith("p2", { name: "P2", status: "paused" }));
    pausedPane.syncFocus(true);
    pausedPane.handleInput("e");
    pausedPane.handleInput("p");
    await flush();
    await flush();
    expect(paused.calls.map((call) => call.method)).toEqual([
      "resumeTask",
      "startTaskExecution",
    ]);

    const pending = recordingService();
    const pendingPane = paneWithService(pending);
    seedCurrent(pendingPane, taskWith("p3", { name: "P3", status: "pending" }));
    pendingPane.syncFocus(true);
    pendingPane.handleInput("e");
    pendingPane.handleInput("p");
    await flush();
    await flush();
    expect(pending.calls.map((call) => call.method)).toEqual([
      "resumeTask",
      "startTaskExecution",
    ]);

    const completed = recordingService();
    const completedPane = paneWithService(completed);
    seedCurrent(
      completedPane,
      taskWith("p4", { name: "P4", status: "completed" }),
    );
    completedPane.syncFocus(true);
    completedPane.handleInput("e");
    completedPane.handleInput("p");
    await flush();
    expect(completed.calls).toEqual([]);
  });

  it("aborts renaming on Escape and commits the prefilled name on Enter", async () => {
    const service = recordingService();
    const { component, taskId } = focusedInEditMode(service);
    component.handleInput("r");
    expect(component.renderContent(80, 24).join("\n")).toContain("Rename:");
    component.handleInput("\x1b");
    expect(component.renderContent(80, 24).join("\n")).not.toContain("Rename:");
    expect(service.calls.map((call) => call.method)).toEqual([]);
    component.handleInput("r");
    component.handleInput("\r");
    await flush();
    expect(service.calls.map((call) => call.method)).toEqual(["renameTask"]);
    expect(service.calls[0]?.args).toEqual([taskId, "Build feature"]);
  });

  it("reports service failures to stderr through the diagnostic path", async () => {
    const service = recordingService(["setUserStatus"]);
    const component = paneWithService(service);
    const task = taskWith("boom", { name: "Boom" });
    seedCurrent(component, task);
    component.syncFocus(true);
    const originalWrite = process.stderr.write;
    const writes: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      component.handleInput("d");
      await flush();
      await flush();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(writes.join("")).toContain("[TaskPane] UI error (setUserStatus)");
  });
});

describe("TaskPane render details", () => {
  it("truncates long names with an ellipsis on narrow panes", () => {
    const component = pane();
    const long = "abcdefghijklmnopqrst";
    useStore.getState().setTasks([taskWith("long", { name: long })]);
    useStore.getState().setCurrentTaskId(stringToUuid("task-pane:long"));
    const rendered = component.renderContent(30, 24).join("\n");
    expect(rendered).toContain("\u23f3 abcdefghijklmn...");
    expect(rendered).toContain(long);
  });

  it("renders the error banner for a task with an error", () => {
    const component = pane();
    seedCurrent(
      component,
      taskWith("broken", { name: "Broken", error: "detonation" }),
    );
    const rendered = component.renderContent(80, 24).join("\n");
    expect(rendered).toContain("Error:");
    expect(rendered).toContain("detonation");
  });

  it("shows and clears the newer-lines scroll indicator", () => {
    const component = pane();
    const output = Array.from({ length: 15 }, (_, i) => `line ${i}`);
    seedCurrent(component, taskWith("scroll", { name: "Scroll", output }));
    component.syncFocus(true);
    component.handleInput("\x1b[1;5A");
    expect(component.renderContent(80, 24).join("\n")).toContain(
      "[\u2193 1 newer lines]",
    );
    component.handleInput("\x1b[1;5B");
    expect(component.renderContent(80, 24).join("\n")).not.toContain(
      "newer lines",
    );
  });

  it("renders distinct icons per execution status", () => {
    const statuses = [
      { status: "completed", icon: "\u2705" },
      { status: "failed", icon: "\u274c" },
      { status: "cancelled", icon: "\ud83d\uded1" },
    ] as const;
    for (const item of statuses) {
      const component = pane();
      useStore
        .getState()
        .setTasks([
          taskWith(item.status, { name: item.status, status: item.status }),
        ]);
      const rendered = component.renderContent(80, 24).join("\n");
      expect(rendered).toContain(item.icon);
    }
  });

  it("formats trace notes, failures, and bare status events", () => {
    const component = pane();
    const task = taskWith("tracey", { name: "Tracey", status: "running" });
    task.metadata.trace = [
      { kind: "note", level: "error", message: "exploded", ts: 1, seq: 1 },
      {
        kind: "tool_result",
        iteration: 1,
        name: "shell",
        success: false,
        output: "nope",
        outputPreview: "nope",
        ts: 2,
        seq: 2,
      },
      { kind: "status", status: "cancelled", ts: 3, seq: 3 },
    ];
    seedCurrent(component, task);
    component.syncFocus(true);
    component.handleInput("t");
    const trace = component.renderContent(80, 24).join("\n");
    expect(trace).toContain("\u274c exploded");
    expect(trace).toContain("\u2717");
    expect(trace).toContain("cancelled");
    expect(trace).not.toContain("\u2014");
  });
});
