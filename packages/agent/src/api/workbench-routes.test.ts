/**
 * Exercises `handleWorkbenchRoutes` routing decisions through the real helper
 * implementations the production context binds: VFS delegation precedence, the
 * GET-only overview guard, todo/trigger source-failure isolation, availability
 * flags, and backward-compatible summary fields. Deterministic harness — the
 * runtime boundary is a scripted `getTasks`, no live HTTP server.
 */

import type http from "node:http";
import type { AgentRuntime, Task } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { listTriggerTasks, taskToTriggerSummary } from "../triggers/runtime.ts";
import { decodePathComponent } from "./server-helpers.ts";
import type {
  WorkbenchRouteContext,
  WorkbenchTodoView,
} from "./workbench-context.ts";
import {
  asObject,
  normalizeTags,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTodo,
} from "./workbench-helpers.ts";
import { handleWorkbenchRoutes } from "./workbench-routes.ts";

type OverviewBody = {
  tasks: unknown[];
  triggers: Array<{ displayName: string; enabled: boolean }>;
  todos: WorkbenchTodoView[];
  summary: {
    totalTasks: number;
    completedTasks: number;
    totalTriggers: number;
    activeTriggers: number;
    totalTodos: number;
    completedTodos: number;
  };
  tasksAvailable: boolean;
  triggersAvailable: boolean;
  todosAvailable: boolean;
};

const AGENT_ID = stringToUuid("workbench-routes-test-agent");

type GetTasks = (query?: { tags?: string[] }) => Promise<Task[]>;

function runtimeWithGetTasks(getTasks: GetTasks): AgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    getTasks,
  } as unknown as AgentRuntime;
}

function todoTask(id: string, name: string, isCompleted = false): Task {
  return {
    id,
    name,
    description: "",
    tags: ["todo"],
    metadata: { isCompleted },
  } as Task;
}

function configuredTriggerTask(
  id: string,
  displayName: string,
  enabled: boolean,
): Task {
  return {
    id,
    name: "WORKFLOW_TRIGGER",
    description: "",
    tags: ["repeat", "trigger"],
    metadata: {
      trigger: {
        triggerId: id,
        displayName,
        instructions: "",
        triggerType: "cron",
        enabled,
      },
    },
  } as Task;
}

function unmappableTriggerTask(id: string, name: string): Task {
  return {
    id,
    name,
    description: "",
    tags: ["repeat", "trigger"],
    metadata: {},
  } as Task;
}

function makeContext(options: {
  method?: string;
  pathname?: string;
  runtime?: AgentRuntime | null;
}): {
  ctx: WorkbenchRouteContext;
  response: { body?: unknown; status?: number };
} {
  const method = options.method ?? "GET";
  const pathname = options.pathname ?? "/api/workbench/overview";
  const url = new URL(pathname, "http://localhost");
  const response: { body?: unknown; status?: number } = {};
  const ctx: WorkbenchRouteContext = {
    req: { method, url: pathname } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    state: { runtime: options.runtime ?? null, adminEntityId: null },
    json: (_res, data, status = 200) => {
      response.body = data;
      response.status = status;
    },
    error: (_res, message, status = 500) => {
      response.body = { error: message };
      response.status = status;
    },
    readJsonBody: async <T extends object>() => null as T | null,
    toWorkbenchTodo,
    normalizeTags,
    readTaskMetadata,
    readTaskCompleted,
    parseNullableNumber,
    asObject,
    decodePathComponent,
    taskToTriggerSummary,
    listTriggerTasks,
  };
  return { ctx, response };
}

function overview(response: { body?: unknown; status?: number }): OverviewBody {
  expect(response.status).toBe(200);
  return response.body as OverviewBody;
}

describe("handleWorkbenchRoutes", () => {
  it("claims nothing for a path outside the workbench surfaces", async () => {
    const { ctx, response } = makeContext({
      pathname: "/api/other",
      runtime: runtimeWithGetTasks(async () => {
        throw new Error("must not be queried");
      }),
    });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(false);
    expect(response).toEqual({});
  });

  it("does not claim the overview route for POST requests", async () => {
    const { ctx, response } = makeContext({
      method: "POST",
      runtime: runtimeWithGetTasks(async () => {
        throw new Error("must not be queried");
      }),
    });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(false);
    expect(response).toEqual({});
  });

  it("hands VFS-owned requests to the real VFS handler before considering the overview", async () => {
    const { ctx, response } = makeContext({
      pathname: "/api/workbench/vfs/plugins",
      runtime: runtimeWithGetTasks(async () => {
        throw new Error("must not be queried");
      }),
    });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    expect(response.status).toBe(200);
    const body = response.body as { plugins?: unknown };
    expect(Array.isArray(body.plugins)).toBe(true);
    expect("summary" in body && body.summary !== undefined).toBe(false);
  });

  it("serves an all-zero overview when no runtime is attached", async () => {
    const { ctx, response } = makeContext({ runtime: null });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    expect(overview(response)).toEqual({
      tasks: [],
      triggers: [],
      todos: [],
      summary: {
        totalTasks: 0,
        completedTasks: 0,
        totalTriggers: 0,
        activeTriggers: 0,
        totalTodos: 0,
        completedTodos: 0,
      },
      tasksAvailable: false,
      triggersAvailable: false,
      todosAvailable: false,
    });
  });

  it("keeps backward-compat task fields empty while todos and triggers load", async () => {
    const runtime = runtimeWithGetTasks(async (query) => {
      const tags = query?.tags ?? [];
      if (tags.includes("trigger")) {
        return [
          configuredTriggerTask("t-enabled", "Zulu Trigger", true),
          configuredTriggerTask("t-disabled", "Yankee Trigger", false),
          unmappableTriggerTask("t-bare", "NO_CONFIG"),
        ];
      }
      if (tags.includes("heartbeat")) return [];
      return [todoTask("open", "Bravo"), todoTask("done", "Alpha", true)];
    });
    const { ctx, response } = makeContext({ runtime });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(response);
    expect(body.tasks).toEqual([]);
    expect(body.tasksAvailable).toBe(false);
    expect(body.summary.totalTasks).toBe(0);
    expect(body.summary.completedTasks).toBe(0);
    expect(body.todos.map((todo) => todo.name)).toEqual(["Alpha", "Bravo"]);
    expect(body.summary.totalTodos).toBe(2);
    expect(body.summary.completedTodos).toBe(1);
    expect(body.todosAvailable).toBe(true);
    expect(body.triggers.map((trigger) => trigger.displayName)).toEqual([
      "Yankee Trigger",
      "Zulu Trigger",
    ]);
    expect(body.summary.totalTriggers).toBe(2);
    expect(body.summary.activeTriggers).toBe(1);
    expect(body.triggersAvailable).toBe(true);
  });

  it("keeps trigger data available when loading todos fails", async () => {
    const runtime = runtimeWithGetTasks(async (query) => {
      const tags = query?.tags ?? [];
      if (tags.includes("trigger")) {
        return [configuredTriggerTask("t1", "Solo Trigger", true)];
      }
      if (tags.includes("heartbeat")) return [];
      throw new Error("todo store unavailable");
    });
    const { ctx, response } = makeContext({ runtime });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(response);
    expect(body.todos).toEqual([]);
    expect(body.todosAvailable).toBe(false);
    expect(body.triggersAvailable).toBe(true);
    expect(body.triggers.map((trigger) => trigger.displayName)).toEqual([
      "Solo Trigger",
    ]);
    expect(body.summary.totalTodos).toBe(0);
    expect(body.summary.totalTriggers).toBe(1);
  });

  it("keeps todo data available when listing triggers fails", async () => {
    const runtime = runtimeWithGetTasks(async (query) => {
      const tags = query?.tags ?? [];
      if (tags.includes("trigger") || tags.includes("heartbeat")) {
        throw new Error("trigger listing unavailable");
      }
      return [todoTask("done", "Done", true)];
    });
    const { ctx, response } = makeContext({ runtime });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(response);
    expect(body.triggers).toEqual([]);
    expect(body.triggersAvailable).toBe(false);
    expect(body.todosAvailable).toBe(true);
    expect(body.todos.map((todo) => todo.id)).toEqual(["done"]);
    expect(body.summary.totalTodos).toBe(1);
    expect(body.summary.completedTodos).toBe(1);
    expect(body.summary.totalTriggers).toBe(0);
  });

  it("still answers the overview when both sources fail", async () => {
    const runtime = runtimeWithGetTasks(async () => {
      throw new Error("storage unavailable");
    });
    const { ctx, response } = makeContext({ runtime });

    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    expect(overview(response)).toMatchObject({
      tasks: [],
      triggers: [],
      todos: [],
      tasksAvailable: false,
      triggersAvailable: false,
      todosAvailable: false,
    });
    expect(response.body).toMatchObject({
      summary: {
        totalTriggers: 0,
        activeTriggers: 0,
        totalTodos: 0,
        completedTodos: 0,
      },
    });
  });
});
