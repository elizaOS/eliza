/**
 * Unit tests for workbench overview and aggregation routes.
 */
import type http from "node:http";
import type { AgentRuntime, Task } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkbenchRouteContext,
  WorkbenchTodoView,
} from "../workbench-context.ts";
import { handleWorkbenchRoutes } from "../workbench-routes.ts";

function createMockContext(overrides: Partial<WorkbenchRouteContext> = {}): {
  ctx: WorkbenchRouteContext;
  jsonCalls: Array<{ data: unknown; status?: number }>;
  errorCalls: Array<{ message: string; status?: number }>;
} {
  const jsonCalls: Array<{ data: unknown; status?: number }> = [];
  const errorCalls: Array<{ message: string; status?: number }> = [];

  const ctx: WorkbenchRouteContext = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/workbench/overview",
    url: new URL("http://localhost/api/workbench/overview"),
    state: {
      runtime: {
        getTasks: vi.fn().mockResolvedValue([]),
      } as unknown as AgentRuntime,
    },
    json: (_res, data, status) => {
      jsonCalls.push({ data, status });
    },
    error: (_res, message, status) => {
      errorCalls.push({ message, status });
    },
    readJsonBody: vi.fn(),
    toWorkbenchTodo: (task: Task): WorkbenchTodoView | null => ({
      id: task.id ?? "t1",
      name: task.name,
      description: task.description,
      isCompleted:
        (task.metadata as { isCompleted?: boolean })?.isCompleted ?? false,
      priority: null,
      type: "task",
      tags: [],
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
    }),
    toWorkbenchTask: vi.fn(),
    listTriggerTasks: vi.fn().mockResolvedValue([]),
    taskToTriggerSummary: vi.fn().mockReturnValue(null),
    ...overrides,
  };

  return { ctx, jsonCalls, errorCalls };
}

describe("workbench-routes", () => {
  describe("GET /api/workbench/overview", () => {
    it("aggregates todos and triggers with summary metrics", async () => {
      const mockTasks: Task[] = [
        {
          id: "task-2",
          name: "Beta Task",
          description: "Second",
          metadata: { isCompleted: true },
        } as unknown as Task,
        {
          id: "task-1",
          name: "Alpha Task",
          description: "First",
          metadata: { isCompleted: false },
        } as unknown as Task,
        {
          id: "task-1", // duplicate id
          name: "Alpha Task Dup",
          description: "First Dup",
          metadata: { isCompleted: false },
        } as unknown as Task,
      ];

      const mockTriggers = [
        { id: "trig-1", displayName: "Daily Sync", enabled: true },
        { id: "trig-2", displayName: "Backup Trigger", enabled: false },
      ];

      const { ctx, jsonCalls } = createMockContext({
        state: {
          runtime: {
            getTasks: vi.fn().mockResolvedValue(mockTasks),
          } as unknown as AgentRuntime,
        },
        listTriggerTasks: vi
          .fn()
          .mockResolvedValue(mockTriggers as unknown as Task[]),
        taskToTriggerSummary: (t: Task) =>
          t as unknown as Record<string, unknown>,
      });

      const handled = await handleWorkbenchRoutes(ctx);
      expect(handled).toBe(true);
      expect(jsonCalls).toHaveLength(1);

      const data = jsonCalls[0]?.data as {
        todos: WorkbenchTodoView[];
        triggers: Array<{ displayName: string }>;
        summary: {
          totalTodos: number;
          completedTodos: number;
          totalTriggers: number;
          activeTriggers: number;
        };
        todosAvailable: boolean;
        triggersAvailable: boolean;
      };

      expect(data.todosAvailable).toBe(true);
      expect(data.triggersAvailable).toBe(true);
      expect(data.todos).toHaveLength(2); // deduped
      expect(data.todos[0]?.name).toBe("Alpha Task Dup"); // sorted alphabetically
      expect(data.todos[1]?.name).toBe("Beta Task");
      expect(data.summary.totalTodos).toBe(2);
      expect(data.summary.completedTodos).toBe(1);
      expect(data.summary.totalTriggers).toBe(2);
      expect(data.summary.activeTriggers).toBe(1);
    });

    it("handles null runtime gracefully with empty lists", async () => {
      const { ctx, jsonCalls } = createMockContext({
        state: { runtime: null },
      });

      const handled = await handleWorkbenchRoutes(ctx);
      expect(handled).toBe(true);
      expect(jsonCalls).toHaveLength(1);

      const data = jsonCalls[0]?.data as {
        todosAvailable: boolean;
        triggersAvailable: boolean;
        todos: unknown[];
      };
      expect(data.todosAvailable).toBe(false);
      expect(data.triggersAvailable).toBe(false);
      expect(data.todos).toHaveLength(0);
    });

    it("returns false for non-matching routes", async () => {
      const { ctx } = createMockContext({
        method: "POST",
        pathname: "/api/other",
      });

      const handled = await handleWorkbenchRoutes(ctx);
      expect(handled).toBe(false);
    });
  });
});
