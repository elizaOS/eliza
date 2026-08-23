/**
 * Pins the workbench route context TypeScript contracts (`WorkbenchTodoView`,
 * `WorkbenchRouteContext`) and drives the real helper implementations those
 * fields bind to: todo mapping, tag normalization, path decoding, trigger
 * listing, and the overview handler that consumes the context. The module is
 * types-only — no live HTTP server.
 */

import type http from "node:http";
import type { AgentRuntime, Task, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { listTriggerTasks, taskToTriggerSummary } from "../triggers/runtime.ts";
import type { TriggerSummary } from "../triggers/types.ts";
import { decodePathComponent } from "./server-helpers.ts";
import type {
  WorkbenchRouteContext,
  WorkbenchTodoView,
} from "./workbench-context.ts";
import * as workbenchContext from "./workbench-context.ts";
import {
  asObject,
  normalizeTags,
  parseNullableNumber,
  readTaskCompleted,
  readTaskMetadata,
  toWorkbenchTodo,
} from "./workbench-helpers.ts";
import {
  handleWorkbenchRoutes,
  type WorkbenchRouteContext as ReexportedContext,
} from "./workbench-routes.ts";

const AGENT_ID = stringToUuid("workbench-context-test-agent");
const CREATED_AT = 1_700_000_000_000;
const CREATED_AT_ISO = new Date(CREATED_AT).toISOString();

function stubRes(): http.ServerResponse {
  const res: {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    setHeader: () => typeof res;
    getHeader: () => undefined;
    writeHead: (status: number) => typeof res;
    write: () => boolean;
    end: () => typeof res;
    on: () => typeof res;
    once: () => typeof res;
    emit: () => boolean;
  } = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader: () => res,
    getHeader: () => undefined,
    writeHead: (status: number) => {
      res.statusCode = status;
      return res;
    },
    write: () => true,
    end: () => {
      res.writableEnded = true;
      res.headersSent = true;
      return res;
    },
    on: () => res,
    once: () => res,
    emit: () => false,
  };
  return res as unknown as http.ServerResponse;
}

function todoTask(
  id: string,
  name: string,
  extras: {
    description?: string;
    tags?: string[];
    metadata?: Record<string, unknown> | null;
    createdAt?: number | null;
    updatedAt?: number | null;
  } = {},
): Task {
  return {
    id,
    name,
    description: extras.description ?? "",
    tags: extras.tags ?? ["todo"],
    metadata: extras.metadata === undefined ? {} : extras.metadata,
    createdAt: extras.createdAt === undefined ? CREATED_AT : extras.createdAt,
    updatedAt: extras.updatedAt === undefined ? CREATED_AT : extras.updatedAt,
  } as Task;
}

function heartbeatTask(id: string, name = "IMESSAGE_HEARTBEAT"): Task {
  return {
    id,
    name,
    description: "",
    tags: ["queue", "repeat", "heartbeat"],
    metadata: {},
  } as Task;
}

function runtime(options: {
  todos?: Task[];
  triggerTasks?: Task[];
  heartbeatTasks?: Task[];
  setting?: (key: string) => unknown;
}): AgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: options.setting ?? (() => undefined),
    getTasks: async (query?: { tags?: string[] }) => {
      const tags = query?.tags ?? [];
      if (tags.includes("trigger")) return options.triggerTasks ?? [];
      if (tags.includes("heartbeat")) return options.heartbeatTasks ?? [];
      return options.todos ?? [];
    },
  } as unknown as AgentRuntime;
}

function makeContext(options: {
  method?: string;
  pathname?: string;
  runtime?: AgentRuntime | null;
  adminEntityId?: UUID | null;
  body?: Record<string, unknown> | null;
}): {
  ctx: WorkbenchRouteContext;
  result: { body?: unknown; status?: number };
} {
  const method = options.method ?? "GET";
  const pathname = options.pathname ?? "/api/workbench/overview";
  const result: { body?: unknown; status?: number } = {};
  const url = new URL(pathname, "http://localhost");
  const ctx: WorkbenchRouteContext = {
    req: { url: pathname, method } as http.IncomingMessage,
    res: stubRes(),
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime: options.runtime ?? null,
      adminEntityId: options.adminEntityId ?? null,
    },
    json: (_res, data, status = 200) => {
      result.body = data;
      result.status = status;
    },
    error: (_res, message, status = 500) => {
      result.body = { error: message };
      result.status = status;
    },
    readJsonBody: async <T extends object>() =>
      (options.body ?? null) as T | null,
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
  return { ctx, result };
}

type OverviewBody = {
  tasks: unknown[];
  triggers: TriggerSummary[];
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

function overview(body: unknown): OverviewBody {
  expect(body).toMatchObject({
    tasks: [],
    tasksAvailable: false,
  });
  return body as OverviewBody;
}

describe("workbench-context", () => {
  it("is types-only: none of the exported contracts exist at runtime", () => {
    expect(Object.keys(workbenchContext)).toEqual([]);
    expect("WorkbenchTodoView" in workbenchContext).toBe(false);
    expect("WorkbenchRouteContext" in workbenchContext).toBe(false);
  });

  it("re-exports the same context type from workbench-routes", () => {
    expectTypeOf<ReexportedContext>().toEqualTypeOf<WorkbenchRouteContext>();
  });
});

describe("WorkbenchTodoView", () => {
  it("requires id, name, description, flags, type, tags, and nullable stamps", () => {
    expectTypeOf<WorkbenchTodoView["id"]>().toEqualTypeOf<string>();
    expectTypeOf<WorkbenchTodoView["name"]>().toEqualTypeOf<string>();
    expectTypeOf<WorkbenchTodoView["description"]>().toEqualTypeOf<string>();
    expectTypeOf<WorkbenchTodoView["priority"]>().toEqualTypeOf<
      number | null
    >();
    expectTypeOf<WorkbenchTodoView["isUrgent"]>().toEqualTypeOf<boolean>();
    expectTypeOf<WorkbenchTodoView["type"]>().toEqualTypeOf<string>();
    expectTypeOf<WorkbenchTodoView["isCompleted"]>().toEqualTypeOf<boolean>();
    expectTypeOf<WorkbenchTodoView["tags"]>().toEqualTypeOf<string[]>();
    expectTypeOf<WorkbenchTodoView["createdAt"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<WorkbenchTodoView["updatedAt"]>().toEqualTypeOf<
      string | null
    >();
  });
});

describe("WorkbenchRouteContext helper signatures", () => {
  it("binds the production helper signatures onto the context", () => {
    expectTypeOf<WorkbenchRouteContext["toWorkbenchTodo"]>().toEqualTypeOf<
      (task: Task) => WorkbenchTodoView | null
    >();
    expectTypeOf<WorkbenchRouteContext["normalizeTags"]>().toEqualTypeOf<
      (value: unknown, required?: string[]) => string[]
    >();
    expectTypeOf<WorkbenchRouteContext["readTaskMetadata"]>().toEqualTypeOf<
      (task: Task) => Record<string, unknown>
    >();
    expectTypeOf<WorkbenchRouteContext["readTaskCompleted"]>().toEqualTypeOf<
      (task: Task) => boolean
    >();
    expectTypeOf<WorkbenchRouteContext["parseNullableNumber"]>().toEqualTypeOf<
      (value: unknown) => number | null
    >();
    expectTypeOf<WorkbenchRouteContext["asObject"]>().toEqualTypeOf<
      (value: unknown) => Record<string, unknown> | null
    >();
    expectTypeOf<WorkbenchRouteContext["taskToTriggerSummary"]>().toEqualTypeOf<
      (task: Task) => TriggerSummary | null
    >();
    expectTypeOf<WorkbenchRouteContext["listTriggerTasks"]>().toEqualTypeOf<
      (runtime: AgentRuntime) => Promise<Task[]>
    >();
    expectTypeOf<
      WorkbenchRouteContext["state"]["runtime"]
    >().toEqualTypeOf<AgentRuntime | null>();
    expectTypeOf<
      WorkbenchRouteContext["state"]["adminEntityId"]
    >().toEqualTypeOf<UUID | null>();
  });
});

describe("toWorkbenchTodo through WorkbenchRouteContext", () => {
  it("returns null for a missing non-todo item", () => {
    const { ctx } = makeContext({});
    expect(
      ctx.toWorkbenchTodo(todoTask("x", "Nope", { tags: ["other"] })),
    ).toBeNull();
  });

  it("returns null when the todo id is missing or blank", () => {
    const { ctx } = makeContext({});
    expect(ctx.toWorkbenchTodo(todoTask("  ", "Blank id"))).toBeNull();
    expect(
      ctx.toWorkbenchTodo(todoTask("", "Empty id", { tags: ["todo"] })),
    ).toBeNull();
  });

  it("maps a single todo with defaults and ISO timestamps", () => {
    const { ctx } = makeContext({});
    const view = ctx.toWorkbenchTodo(todoTask("t1", "Buy milk"));
    expect(view).toEqual({
      id: "t1",
      name: "Buy milk",
      description: "",
      priority: null,
      isUrgent: false,
      type: "task",
      isCompleted: false,
      tags: ["todo"],
      createdAt: CREATED_AT_ISO,
      updatedAt: CREATED_AT_ISO,
    } satisfies WorkbenchTodoView);
  });

  it("uses fallback name, null stamps, nested priority, and urgent flag", () => {
    const { ctx } = makeContext({});
    const view = ctx.toWorkbenchTodo(
      todoTask("t2", "   ", {
        description: "task-level",
        createdAt: null,
        updatedAt: null,
        metadata: {
          workbenchTodo: {
            description: "from meta",
            priority: "7",
            isUrgent: true,
            type: "chore",
            isCompleted: true,
          },
        },
      }),
    );
    expect(view).toEqual({
      id: "t2",
      name: "Todo",
      description: "from meta",
      priority: 7,
      isUrgent: true,
      type: "chore",
      isCompleted: true,
      tags: ["todo"],
      createdAt: null,
      updatedAt: null,
    } satisfies WorkbenchTodoView);
  });

  it("treats a zero createdAt as missing (falsy) rather than epoch", () => {
    const { ctx } = makeContext({});
    const view = ctx.toWorkbenchTodo(
      todoTask("t3", "Zero stamp", { createdAt: 0, updatedAt: 0 }),
    );
    expect(view?.createdAt).toBeNull();
    expect(view?.updatedAt).toBeNull();
  });
});

describe("normalizeTags / parseNullableNumber / asObject through context", () => {
  it("returns an empty tag list for garbage and merges required tags", () => {
    const { ctx } = makeContext({});
    expect(ctx.normalizeTags(undefined)).toEqual([]);
    expect(ctx.normalizeTags("not-array")).toEqual([]);
    expect(ctx.normalizeTags([])).toEqual([]);
    expect(ctx.normalizeTags(["a", "b"], ["b", " c ", ""])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("dedupes overflow duplicate tags (set insertion, first spelling wins)", () => {
    const { ctx } = makeContext({});
    expect(
      ctx.normalizeTags(["alpha", "beta", "alpha", "gamma"], ["beta"]),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses numbers, rejects NaN/Infinity/empty, and reads objects only", () => {
    const { ctx } = makeContext({});
    expect(ctx.parseNullableNumber(5)).toBe(5);
    expect(ctx.parseNullableNumber("8")).toBe(8);
    expect(ctx.parseNullableNumber("")).toBeNull();
    expect(ctx.parseNullableNumber(Number.NaN)).toBeNull();
    expect(ctx.parseNullableNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(ctx.parseNullableNumber("nope")).toBeNull();
    expect(ctx.asObject({ a: 1 })).toEqual({ a: 1 });
    expect(ctx.asObject(null)).toBeNull();
    expect(ctx.asObject([])).toBeNull();
    expect(ctx.asObject(42)).toBeNull();
  });

  it("reads metadata safely and completed flags from nested todo meta", () => {
    const { ctx } = makeContext({});
    expect(
      ctx.readTaskMetadata(todoTask("t", "n", { metadata: null })),
    ).toEqual({});
    expect(
      ctx.readTaskCompleted(
        todoTask("t", "n", { metadata: { isCompleted: true } }),
      ),
    ).toBe(true);
    expect(ctx.readTaskCompleted(todoTask("t", "n"))).toBe(false);
  });
});

describe("decodePathComponent through WorkbenchRouteContext", () => {
  it("decodes a single encoded segment", () => {
    const { ctx } = makeContext({});
    expect(ctx.decodePathComponent("hello%20world", ctx.res, "path")).toBe(
      "hello world",
    );
  });

  it("returns null for malformed encoding instead of throwing", () => {
    const { ctx } = makeContext({});
    expect(ctx.decodePathComponent("%", ctx.res, "VFS project id")).toBeNull();
    expect(
      ctx.decodePathComponent("%ZZ", ctx.res, "VFS project id"),
    ).toBeNull();
    expect((ctx.res as { statusCode: number }).statusCode).toBe(400);
  });
});

describe("taskToTriggerSummary / listTriggerTasks through context", () => {
  it("returns null for a missing trigger (plain task is not a summary)", () => {
    const { ctx } = makeContext({});
    expect(
      ctx.taskToTriggerSummary(todoTask("plain", "Just a todo")),
    ).toBeNull();
  });

  it("synthesizes a heartbeat summary and skips a heartbeat with no id", () => {
    const { ctx } = makeContext({});
    const id = stringToUuid("heartbeat-1");
    const summary = ctx.taskToTriggerSummary(heartbeatTask(id));
    expect(summary?.id).toBe(id);
    expect(summary?.displayName).toBe("Imessage Heartbeat");
    expect(summary?.triggerType).toBe("interval");
    expect(summary?.enabled).toBe(true);
    expect(ctx.taskToTriggerSummary(heartbeatTask("", "NO_ID"))).toBeNull();
  });

  it("returns an empty queue when triggers are disabled", async () => {
    const { ctx } = makeContext({});
    const tasks = await ctx.listTriggerTasks(
      runtime({
        setting: (key) => (key === "ELIZA_TRIGGERS_ENABLED" ? "0" : undefined),
        triggerTasks: [
          todoTask("t", "should-not-appear", { tags: ["trigger"] }),
        ],
      }),
    );
    expect(tasks).toEqual([]);
  });

  it("returns a single trigger task and dedupes a tied duplicate id", async () => {
    const { ctx } = makeContext({});
    const sharedId = stringToUuid("shared-trigger");
    const first: Task = {
      id: sharedId,
      name: "FIRST",
      description: "keep",
      tags: ["repeat", "trigger"],
      metadata: {},
    } as Task;
    const duplicate: Task = {
      id: sharedId,
      name: "SECOND",
      description: "drop",
      tags: ["repeat", "heartbeat"],
      metadata: {},
    } as Task;
    const extra = heartbeatTask(stringToUuid("heartbeat-extra"));

    const tasks = await ctx.listTriggerTasks(
      runtime({
        triggerTasks: [first],
        heartbeatTasks: [duplicate, extra],
      }),
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.name).toBe("FIRST");
    expect(tasks.map((task) => task.id)).toEqual([sharedId, extra.id]);
  });

  it("keeps an overflow list of distinct tasks (no silent drop)", async () => {
    const { ctx } = makeContext({});
    const triggerTasks = Array.from({ length: 8 }, (_, index) => ({
      id: stringToUuid(`overflow-trigger-${index}`),
      name: `T${index}`,
      description: "",
      tags: ["repeat", "trigger"],
      metadata: {},
    })) as Task[];
    const tasks = await ctx.listTriggerTasks(runtime({ triggerTasks }));
    expect(tasks).toHaveLength(8);
  });
});

describe("handleWorkbenchRoutes overview via WorkbenchRouteContext", () => {
  it("returns false for a path the workbench handler does not own", async () => {
    const { ctx } = makeContext({ pathname: "/api/other" });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(false);
  });

  it("returns an empty todo/trigger queue when runtime is null", async () => {
    const { ctx, result } = makeContext({ runtime: null });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(result.body);
    expect(body.todos).toEqual([]);
    expect(body.triggers).toEqual([]);
    expect(body.todosAvailable).toBe(false);
    expect(body.triggersAvailable).toBe(false);
    expect(body.summary.totalTodos).toBe(0);
    expect(result.status).toBe(200);
  });

  it("maps a single todo and skips a missing non-todo item", async () => {
    const { ctx, result } = makeContext({
      runtime: runtime({
        todos: [
          todoTask("keep", "Alpha"),
          todoTask("skip", "Not a todo", { tags: ["other"] }),
        ],
      }),
    });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(result.body);
    expect(body.todos.map((todo) => todo.id)).toEqual(["keep"]);
    expect(body.todos[0]?.name).toBe("Alpha");
    expect(body.todosAvailable).toBe(true);
    expect(body.summary.totalTodos).toBe(1);
    expect(body.summary.completedTodos).toBe(0);
  });

  it("sorts todos by name and last-wins a tied duplicate id", async () => {
    const { ctx, result } = makeContext({
      runtime: runtime({
        todos: [
          todoTask("c", "Charlie"),
          todoTask("dup", "Zeta"),
          todoTask("dup", "Alpha"),
          todoTask("b", "Bravo"),
        ],
      }),
    });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(result.body);
    expect(body.todos.map((todo) => todo.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(body.todos.map((todo) => todo.id)).toEqual(["dup", "b", "c"]);
    expect(body.summary.totalTodos).toBe(3);
  });

  it("keeps equal-name ties in first-seen order after the name sort", async () => {
    const { ctx, result } = makeContext({
      runtime: runtime({
        todos: [todoTask("one", "Same"), todoTask("two", "Same")],
      }),
    });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(result.body);
    expect(body.todos.map((todo) => todo.id)).toEqual(["one", "two"]);
  });

  it("counts completed todos and sorts trigger summaries by displayName", async () => {
    const hbLate = heartbeatTask(stringToUuid("hb-late"), "ZULU_BEAT");
    const hbEarly = heartbeatTask(stringToUuid("hb-early"), "ALPHA_BEAT");
    const { ctx, result } = makeContext({
      runtime: runtime({
        todos: [
          todoTask("open", "Open"),
          todoTask("done", "Done", { metadata: { isCompleted: true } }),
        ],
        heartbeatTasks: [hbLate, hbEarly],
      }),
    });
    await expect(handleWorkbenchRoutes(ctx)).resolves.toBe(true);
    const body = overview(result.body);
    expect(body.summary.completedTodos).toBe(1);
    expect(body.summary.totalTodos).toBe(2);
    expect(body.triggers.map((trigger) => trigger.displayName)).toEqual([
      "Alpha Beat",
      "Zulu Beat",
    ]);
    expect(body.summary.totalTriggers).toBe(2);
    expect(body.summary.activeTriggers).toBe(2);
  });
});
