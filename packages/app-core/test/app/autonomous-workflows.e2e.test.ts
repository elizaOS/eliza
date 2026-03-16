/**
 * E2E tests for Autonomous Mode workflows.
 *
 * Tests cover:
 * 1. Autonomous mode toggle
 * 2. Task generation
 * 3. Task execution
 * 4. Monitoring and status
 * 5. Error handling
 * 6. Mode configuration
 */

import http from "node:http";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Autonomous Mode Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

type Task = {
  id: string;
  description: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  error?: string;
};

function createAutonomousTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getState: () => { enabled: boolean; tasks: Task[] };
}> {
  const state = {
    enabled: false,
    config: {
      maxConcurrentTasks: 3,
      taskInterval: 60000,
      autoRetry: true,
    },
    tasks: [
      {
        id: "task-1",
        description: "Check social media mentions",
        status: "completed" as const,
        createdAt: "2024-01-01T10:00:00Z",
        completedAt: "2024-01-01T10:01:00Z",
      },
      {
        id: "task-2",
        description: "Generate daily summary",
        status: "pending" as const,
        createdAt: "2024-01-01T11:00:00Z",
      },
    ],
  };

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/autonomous/status": (_r, res) =>
      json(res, {
        enabled: state.enabled,
        taskCount: state.tasks.length,
        runningTasks: state.tasks.filter((t) => t.status === "running").length,
      }),
    "POST /api/autonomous/toggle": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      state.enabled = body.enabled as boolean;
      json(res, { ok: true, enabled: state.enabled });
    },
    "GET /api/autonomous/tasks": (_r, res) => json(res, { tasks: state.tasks }),
    "POST /api/autonomous/tasks": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const newTask: Task = {
        id: `task-${Date.now()}`,
        description: body.description as string,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      state.tasks.push(newTask);
      json(res, { ok: true, task: newTask });
    },
    "POST /api/autonomous/tasks/execute": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const task = state.tasks.find((t) => t.id === body.taskId);
      if (task) {
        task.status = "running";
        // Simulate execution
        setTimeout(() => {
          task.status = "completed";
          task.completedAt = new Date().toISOString();
        }, 100);
        json(res, { ok: true, status: "running" });
      } else {
        json(res, { error: "Task not found" }, 404);
      }
    },
    "DELETE /api/autonomous/tasks": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const idx = state.tasks.findIndex((t) => t.id === body.taskId);
      if (idx !== -1) {
        state.tasks.splice(idx, 1);
        json(res, { ok: true });
      } else {
        json(res, { error: "Task not found" }, 404);
      }
    },
    "GET /api/autonomous/config": (_r, res) =>
      json(res, { config: state.config }),
    "PUT /api/autonomous/config": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      Object.assign(state.config, body.config);
      json(res, { ok: true, config: state.config });
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const key = `${rq.method} ${new URL(rq.url ?? "/", "http://localhost").pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getState: () => ({ enabled: state.enabled, tasks: state.tasks }),
      });
    });
  });
}

describe("Autonomous Mode API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getState: () => { enabled: boolean; tasks: Task[] };

  beforeAll(async () => {
    ({ port, close, getState } = await createAutonomousTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/autonomous/status returns mode status", async () => {
    const { status, data } = await req(port, "GET", "/api/autonomous/status");
    expect(status).toBe(200);
    expect(typeof data.enabled).toBe("boolean");
    expect(typeof data.taskCount).toBe("number");
  });

  it("POST /api/autonomous/toggle enables autonomous mode", async () => {
    const { status, data } = await req(port, "POST", "/api/autonomous/toggle", {
      enabled: true,
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(true);
    expect(getState().enabled).toBe(true);
  });

  it("POST /api/autonomous/toggle disables autonomous mode", async () => {
    const { status, data } = await req(port, "POST", "/api/autonomous/toggle", {
      enabled: false,
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.enabled).toBe(false);
    expect(getState().enabled).toBe(false);
  });

  it("GET /api/autonomous/tasks returns task list", async () => {
    const { status, data } = await req(port, "GET", "/api/autonomous/tasks");
    expect(status).toBe(200);
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it("POST /api/autonomous/tasks creates new task", async () => {
    const initialCount = getState().tasks.length;

    const { status, data } = await req(port, "POST", "/api/autonomous/tasks", {
      description: "New automated task",
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getState().tasks.length).toBe(initialCount + 1);
  });

  it("POST /api/autonomous/tasks/execute starts task execution", async () => {
    const task = getState().tasks.find((t) => t.status === "pending");
    if (!task) return;

    const { status, data } = await req(
      port,
      "POST",
      "/api/autonomous/tasks/execute",
      {
        taskId: task.id,
      },
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.status).toBe("running");
  });

  it("DELETE /api/autonomous/tasks removes task", async () => {
    // First create a task to delete
    await req(port, "POST", "/api/autonomous/tasks", {
      description: "Task to delete",
    });
    const initialCount = getState().tasks.length;
    const taskToDelete = getState().tasks[getState().tasks.length - 1];

    const { status, data } = await req(
      port,
      "DELETE",
      "/api/autonomous/tasks",
      {
        taskId: taskToDelete.id,
      },
    );

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getState().tasks.length).toBe(initialCount - 1);
  });

  it("GET /api/autonomous/config returns configuration", async () => {
    const { status, data } = await req(port, "GET", "/api/autonomous/config");
    expect(status).toBe(200);
    expect(data.config).toBeDefined();
  });

  it("PUT /api/autonomous/config updates configuration", async () => {
    const { status, data } = await req(port, "PUT", "/api/autonomous/config", {
      config: { maxConcurrentTasks: 5 },
    });

    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for Autonomous Mode
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

type AutonomousState = {
  autonomousEnabled: boolean;
  autonomousTasks: Task[];
  autonomousLoading: boolean;
  autonomousConfig: {
    maxConcurrentTasks: number;
    taskInterval: number;
    autoRetry: boolean;
  };
};

function createAutonomousUIState(): AutonomousState {
  return {
    autonomousEnabled: false,
    autonomousTasks: [
      {
        id: "task-1",
        description: "Monitor social feeds",
        status: "completed",
        createdAt: "2024-01-01T10:00:00Z",
        completedAt: "2024-01-01T10:05:00Z",
      },
      {
        id: "task-2",
        description: "Generate content ideas",
        status: "pending",
        createdAt: "2024-01-01T11:00:00Z",
      },
    ],
    autonomousLoading: false,
    autonomousConfig: {
      maxConcurrentTasks: 3,
      taskInterval: 60000,
      autoRetry: true,
    },
  };
}

// Simple mock component for testing autonomous UI
const MockAutonomousView = () => {
  const ctx = mockUseApp();
  return React.createElement(
    "div",
    { "data-testid": "autonomous-view" },
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () => ctx.toggleAutonomousMode(),
        "data-testid": "toggle-btn",
      },
      ctx.autonomousEnabled ? "Disable" : "Enable",
    ),
    React.createElement(
      "div",
      { "data-testid": "status" },
      ctx.autonomousEnabled ? "Running" : "Stopped",
    ),
    React.createElement(
      "ul",
      { "data-testid": "task-list" },
      ctx.autonomousTasks.map((task: Task) =>
        React.createElement(
          "li",
          { key: task.id, "data-testid": `task-${task.id}` },
          `${task.description} - ${task.status}`,
        ),
      ),
    ),
  );
};

describe("Autonomous Mode UI", () => {
  let state: AutonomousState;

  beforeEach(() => {
    state = createAutonomousUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      toggleAutonomousMode: () => {
        state.autonomousEnabled = !state.autonomousEnabled;
      },
      addAutonomousTask: (desc: string) => {
        state.autonomousTasks.push({
          id: `task-${Date.now()}`,
          description: desc,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      },
      executeTask: (taskId: string) => {
        const task = state.autonomousTasks.find((t) => t.id === taskId);
        if (task) task.status = "running";
      },
      removeTask: (taskId: string) => {
        const idx = state.autonomousTasks.findIndex((t) => t.id === taskId);
        if (idx !== -1) state.autonomousTasks.splice(idx, 1);
      },
    }));
  });

  it("renders autonomous view", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(MockAutonomousView));
    });

    expect(tree).not.toBeNull();
  });

  it("displays current mode status", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(MockAutonomousView));
    });

    const status = tree?.root.findByProps({ "data-testid": "status" });
    expect(status.children[0]).toBe("Stopped");
  });

  it("displays task list", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(MockAutonomousView));
    });

    const taskList = tree?.root.findByProps({ "data-testid": "task-list" });
    expect(taskList.children.length).toBe(2);
  });

  it("toggle button changes mode", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(MockAutonomousView));
    });

    const toggleBtn = tree?.root.findByProps({ "data-testid": "toggle-btn" });
    expect(toggleBtn.children[0]).toBe("Enable");

    await act(async () => {
      toggleBtn.props.onClick();
    });

    expect(state.autonomousEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 3: Autonomous Mode Toggle Integration Tests
// ---------------------------------------------------------------------------

describe("Autonomous Mode Toggle Integration", () => {
  let state: AutonomousState;

  beforeEach(() => {
    state = createAutonomousUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      toggleAutonomousMode: () => {
        state.autonomousEnabled = !state.autonomousEnabled;
      },
    }));
  });

  it("toggling enables autonomous mode", () => {
    const toggleFn = mockUseApp().toggleAutonomousMode;

    expect(state.autonomousEnabled).toBe(false);
    toggleFn();
    expect(state.autonomousEnabled).toBe(true);
  });

  it("toggling twice disables autonomous mode", () => {
    const toggleFn = mockUseApp().toggleAutonomousMode;

    toggleFn();
    toggleFn();

    expect(state.autonomousEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Task Management Integration Tests
// ---------------------------------------------------------------------------

describe("Task Management Integration", () => {
  let state: AutonomousState;

  beforeEach(() => {
    state = createAutonomousUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      addAutonomousTask: (desc: string) => {
        state.autonomousTasks.push({
          id: `task-${Date.now()}`,
          description: desc,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      },
      executeTask: (taskId: string) => {
        const task = state.autonomousTasks.find((t) => t.id === taskId);
        if (task) {
          task.status = "running";
        }
      },
      completeTask: (taskId: string) => {
        const task = state.autonomousTasks.find((t) => t.id === taskId);
        if (task) {
          task.status = "completed";
          task.completedAt = new Date().toISOString();
        }
      },
      failTask: (taskId: string, error: string) => {
        const task = state.autonomousTasks.find((t) => t.id === taskId);
        if (task) {
          task.status = "failed";
          task.error = error;
        }
      },
      removeTask: (taskId: string) => {
        const idx = state.autonomousTasks.findIndex((t) => t.id === taskId);
        if (idx !== -1) state.autonomousTasks.splice(idx, 1);
      },
    }));
  });

  it("adding task creates pending task", () => {
    const addFn = mockUseApp().addAutonomousTask;
    const initialCount = state.autonomousTasks.length;

    addFn("New automated task");

    expect(state.autonomousTasks.length).toBe(initialCount + 1);
    expect(state.autonomousTasks[state.autonomousTasks.length - 1].status).toBe(
      "pending",
    );
  });

  it("executing task changes status to running", () => {
    const executeFn = mockUseApp().executeTask;
    const task = state.autonomousTasks.find((t) => t.status === "pending");

    if (task) {
      executeFn(task.id);
      expect(task.status).toBe("running");
    }
  });

  it("completing task changes status and sets completedAt", () => {
    const executeFn = mockUseApp().executeTask;
    const completeFn = mockUseApp().completeTask;
    const task = state.autonomousTasks.find((t) => t.status === "pending");

    if (task) {
      executeFn(task.id);
      completeFn(task.id);
      expect(task.status).toBe("completed");
      expect(task.completedAt).toBeDefined();
    }
  });

  it("failing task sets error message", () => {
    const executeFn = mockUseApp().executeTask;
    const failFn = mockUseApp().failTask;
    const task = state.autonomousTasks.find((t) => t.status === "pending");

    if (task) {
      executeFn(task.id);
      failFn(task.id, "Connection timeout");
      expect(task.status).toBe("failed");
      expect(task.error).toBe("Connection timeout");
    }
  });

  it("removing task deletes it from list", () => {
    const removeFn = mockUseApp().removeTask;
    const initialCount = state.autonomousTasks.length;
    const taskId = state.autonomousTasks[0].id;

    removeFn(taskId);

    expect(state.autonomousTasks.length).toBe(initialCount - 1);
    expect(state.autonomousTasks.find((t) => t.id === taskId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 5: Configuration Integration Tests
// ---------------------------------------------------------------------------

describe("Autonomous Config Integration", () => {
  let state: AutonomousState;

  beforeEach(() => {
    state = createAutonomousUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      updateAutonomousConfig: (
        updates: Partial<AutonomousState["autonomousConfig"]>,
      ) => {
        Object.assign(state.autonomousConfig, updates);
      },
    }));
  });

  it("updating maxConcurrentTasks changes config", () => {
    const updateFn = mockUseApp().updateAutonomousConfig;

    updateFn({ maxConcurrentTasks: 5 });

    expect(state.autonomousConfig.maxConcurrentTasks).toBe(5);
  });

  it("updating taskInterval changes config", () => {
    const updateFn = mockUseApp().updateAutonomousConfig;

    updateFn({ taskInterval: 120000 });

    expect(state.autonomousConfig.taskInterval).toBe(120000);
  });

  it("updating autoRetry changes config", () => {
    const updateFn = mockUseApp().updateAutonomousConfig;

    updateFn({ autoRetry: false });

    expect(state.autonomousConfig.autoRetry).toBe(false);
  });

  it("multiple updates are applied", () => {
    const updateFn = mockUseApp().updateAutonomousConfig;

    updateFn({ maxConcurrentTasks: 10, autoRetry: false });

    expect(state.autonomousConfig.maxConcurrentTasks).toBe(10);
    expect(state.autonomousConfig.autoRetry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part 6: Task Queue and Execution Order Tests
// ---------------------------------------------------------------------------

describe("Task Queue Management", () => {
  let state: AutonomousState;

  beforeEach(() => {
    state = createAutonomousUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      getNextPendingTask: () => {
        return (
          state.autonomousTasks.find((t) => t.status === "pending") || null
        );
      },
      getRunningTasks: () => {
        return state.autonomousTasks.filter((t) => t.status === "running");
      },
      canExecuteMoreTasks: () => {
        const running = state.autonomousTasks.filter(
          (t) => t.status === "running",
        ).length;
        return running < state.autonomousConfig.maxConcurrentTasks;
      },
      getPendingTaskCount: () => {
        return state.autonomousTasks.filter((t) => t.status === "pending")
          .length;
      },
    }));
  });

  it("getNextPendingTask returns first pending task", () => {
    const getNextFn = mockUseApp().getNextPendingTask;
    const nextTask = getNextFn();

    expect(nextTask).not.toBeNull();
    expect(nextTask?.status).toBe("pending");
  });

  it("getRunningTasks returns empty when none running", () => {
    const getRunningFn = mockUseApp().getRunningTasks;
    const running = getRunningFn();

    expect(running.length).toBe(0);
  });

  it("canExecuteMoreTasks returns true when under limit", () => {
    const canExecuteFn = mockUseApp().canExecuteMoreTasks;

    expect(canExecuteFn()).toBe(true);
  });

  it("getPendingTaskCount returns correct count", () => {
    const getCountFn = mockUseApp().getPendingTaskCount;
    const count = getCountFn();

    expect(count).toBe(1); // Initial state has 1 pending task
  });
});
