import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentTodosProvider } from "../providers/current-todos.js";
import { TODOS_SERVICE_TYPE } from "../types.js";
import { todoAction } from "./todo.js";

const ENTITY = "00000000-0000-0000-0000-0000000000aa";
const AGENT = "00000000-0000-0000-0000-0000000000bb";
const ROOM = "00000000-0000-0000-0000-0000000000cc";
const WORLD = "00000000-0000-0000-0000-0000000000dd";

interface StoredTodo {
  id: string;
  entityId: string;
  agentId: string;
  roomId: string | null;
  worldId: string | null;
  content: string;
  activeForm: string;
  status: string;
  parentTodoId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

class FakeTodosService {
  private nextId = 0;
  rows: StoredTodo[] = [];
  failOn: string | null = null;

  private throwIf(operation: string): void {
    if (this.failOn === operation) {
      throw new Error(`forced ${operation} failure`);
    }
  }

  newId(): string {
    this.nextId++;
    return `todo-${this.nextId.toString().padStart(8, "0")}`;
  }

  async create(input: Record<string, unknown>): Promise<StoredTodo> {
    this.throwIf("create");
    const now = new Date();
    const row: StoredTodo = {
      id: this.newId(),
      entityId: String(input.entityId),
      agentId: String(input.agentId),
      roomId: (input.roomId as string | null) ?? null,
      worldId: (input.worldId as string | null) ?? null,
      content: String(input.content),
      activeForm: String(input.activeForm ?? input.content),
      status: String(input.status ?? "pending"),
      parentTodoId: (input.parentTodoId as string | null) ?? null,
      parentTrajectoryStepId:
        (input.parentTrajectoryStepId as string | null) ?? null,
      metadata: (input.metadata as Record<string, unknown>) ?? {},
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.push(row);
    return row;
  }

  async get(id: string): Promise<StoredTodo | null> {
    this.throwIf("get");
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async list(filter: {
    entityId: string;
    agentId?: string;
    roomId?: string | null;
    includeCompleted?: boolean;
  }): Promise<StoredTodo[]> {
    this.throwIf("list");
    return this.rows.filter((r) => {
      if (r.entityId !== filter.entityId) return false;
      if (filter.agentId && r.agentId !== filter.agentId) return false;
      if (filter.roomId && r.roomId !== filter.roomId) return false;
      if (
        filter.includeCompleted === false &&
        (r.status === "completed" || r.status === "cancelled")
      ) {
        return false;
      }
      return true;
    });
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<StoredTodo | null> {
    this.throwIf("update");
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (patch.content !== undefined) row.content = String(patch.content);
    if (patch.activeForm !== undefined)
      row.activeForm = String(patch.activeForm);
    if (patch.status !== undefined) {
      row.status = String(patch.status);
      row.completedAt = row.status === "completed" ? new Date() : null;
    }
    if (patch.parentTodoId !== undefined) {
      row.parentTodoId = (patch.parentTodoId as string | null) ?? null;
    }
    row.updatedAt = new Date();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    this.throwIf("delete");
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }

  async writeList(args: {
    entityId: string;
    agentId: string;
    roomId: string | null;
    worldId: string | null;
    parentTrajectoryStepId: string | null;
    todos: Array<{
      id?: string;
      content: string;
      status: string;
      activeForm?: string;
    }>;
  }): Promise<{ before: StoredTodo[]; after: StoredTodo[] }> {
    this.throwIf("writeList");
    const before = await this.list({
      entityId: args.entityId,
      agentId: args.agentId,
      roomId: args.roomId,
    });
    const beforeById = new Map(before.map((t) => [t.id, t]));
    const keep = new Set<string>();
    const after: StoredTodo[] = [];
    for (const item of args.todos) {
      const existing = item.id ? beforeById.get(item.id) : undefined;
      if (existing) {
        keep.add(existing.id);
        const updated = await this.update(existing.id, {
          content: item.content,
          status: item.status,
          activeForm: item.activeForm ?? item.content,
        });
        if (updated) after.push(updated);
      } else {
        const created = await this.create({
          entityId: args.entityId,
          agentId: args.agentId,
          roomId: args.roomId,
          worldId: args.worldId,
          content: item.content,
          status: item.status,
          activeForm: item.activeForm ?? item.content,
          parentTrajectoryStepId: args.parentTrajectoryStepId,
        });
        keep.add(created.id);
        after.push(created);
      }
    }
    this.rows = this.rows.filter((r) => {
      if (r.entityId !== args.entityId) return true;
      if (r.agentId !== args.agentId) return true;
      if (r.roomId !== args.roomId) return true;
      return keep.has(r.id);
    });
    return { before, after };
  }

  async clear(filter: {
    entityId: string;
    agentId?: string;
    roomId?: string | null;
  }): Promise<number> {
    this.throwIf("clear");
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => {
      if (r.entityId !== filter.entityId) return true;
      if (filter.agentId && r.agentId !== filter.agentId) return true;
      if (filter.roomId && r.roomId !== filter.roomId) return true;
      return false;
    });
    return before - this.rows.length;
  }
}

function mockRuntime(service: FakeTodosService): IAgentRuntime {
  const stub = {
    agentId: AGENT,
    getSetting: (): string | boolean | number | null => null,
    getService: ((name: string) =>
      name === TODOS_SERVICE_TYPE
        ? service
        : null) as IAgentRuntime["getService"],
  };
  return stub as never as IAgentRuntime;
}

function makeMessage(overrides: Partial<Memory> = {}): Memory {
  return {
    entityId: ENTITY,
    roomId: ROOM,
    worldId: WORLD,
    content: { text: "" },
    ...overrides,
  } as Memory;
}

async function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  message: Memory = makeMessage(),
): Promise<ActionResult> {
  const opts = { parameters } as HandlerOptions;
  const result = await todoAction.handler!(runtime, message, undefined, opts);
  if (result === undefined) {
    throw new Error("todoAction.handler returned undefined");
  }
  return result;
}

describe("TODO action", () => {
  let service: FakeTodosService;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    service = new FakeTodosService();
    runtime = mockRuntime(service);
  });

  afterEach(() => {
    delete process.env.ELIZA_PARENT_TRAJECTORY_STEP_ID;
  });

  describe("action=write", () => {
    it("writes a mixed list and renders markdown", async () => {
      const result = await invoke(runtime, {
        action: "write",
        todos: [
          { content: "first task", status: "pending" },
          { content: "doing now", status: "in_progress" },
          { content: "old work", status: "completed" },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.text).toContain("[ ] first task");
      expect(result.text).toContain("[→] doing now");
      expect(result.text).toContain("[x] old work");
      expect(service.rows.length).toBe(3);
      expect(service.rows.every((r) => r.entityId === ENTITY)).toBe(true);
    });

    it("returns previous list as oldTodos and reconciles by id", async () => {
      await invoke(runtime, {
        action: "write",
        todos: [{ content: "original", status: "pending" }],
      });
      const originalId = service.rows[0]!.id;
      const result = await invoke(runtime, {
        action: "write",
        todos: [
          { id: originalId, content: "original", status: "completed" },
          { content: "added", status: "pending" },
        ],
      });
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect((data.oldTodos as unknown[]).length).toBe(1);
      expect(service.rows.length).toBe(2);
      const stored = service.rows.find((r) => r.id === originalId);
      expect(stored?.status).toBe("completed");
    });

    it("rejects invalid status", async () => {
      const result = await invoke(runtime, {
        action: "write",
        todos: [{ content: "foo", status: "weird" }],
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("invalid_param");
    });

    it("captures parentTrajectoryStepId from env on new rows", async () => {
      process.env.ELIZA_PARENT_TRAJECTORY_STEP_ID = "parent-step-99";
      await invoke(runtime, {
        action: "write",
        todos: [{ content: "child task", status: "pending" }],
      });
      expect(service.rows[0]!.parentTrajectoryStepId).toBe("parent-step-99");
    });

    it("preserves caller order while reconciling mixed existing and new rows", async () => {
      await invoke(runtime, {
        action: "write",
        todos: [
          { content: "alpha", status: "pending" },
          { content: "bravo", status: "pending" },
          { content: "charlie", status: "pending" },
        ],
      });
      const [alpha, , charlie] = service.rows;

      const result = await invoke(runtime, {
        action: "write",
        todos: [
          { id: charlie!.id, content: "charlie next", status: "in_progress" },
          { content: "delta", status: "pending" },
          { id: alpha!.id, content: "alpha done", status: "completed" },
        ],
      });

      expect(result.success).toBe(true);
      const data = result.data as { todos: StoredTodo[] };
      expect(data.todos.map((todo) => todo.content)).toEqual([
        "charlie next",
        "delta",
        "alpha done",
      ]);
      expect(service.rows.map((todo) => todo.content)).toEqual([
        "alpha done",
        "charlie next",
        "delta",
      ]);
    });

    it("rejects malformed todo arrays without mutating existing rows", async () => {
      await invoke(runtime, {
        action: "create",
        content: "keep me",
      });
      const malformedPayloads: unknown[] = [
        undefined,
        null,
        "not-an-array",
        [null],
        [false],
        [{}],
        [{ content: "", status: "pending" }],
        [{ content: "x", status: "" }],
        [{ content: "x", status: "blocked" }],
        [{ content: { nested: true }, status: "pending" }],
        [{ content: "x", status: { nested: true } }],
      ];

      for (const todos of malformedPayloads) {
        const result = await invoke(runtime, { action: "write", todos });
        expect(result.success).toBe(false);
        expect(result.text).toMatch(/invalid_param/);
        expect(service.rows.map((row) => row.content)).toEqual(["keep me"]);
      }
    });

    it("ignores hostile field names instead of polluting prototypes", async () => {
      const hostile = JSON.parse(
        '{"content":"safe","status":"pending","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      ) as Record<string, unknown>;

      const result = await invoke(runtime, {
        action: "write",
        todos: [hostile],
      });

      expect(result.success).toBe(true);
      expect(service.rows[0]?.content).toBe("safe");
      expect(
        (Object.prototype as Record<string, unknown>).polluted,
      ).toBeUndefined();
      expect(service.rows[0]?.metadata).toEqual({});
    });
  });

  describe("action=create", () => {
    it("creates a single todo scoped to entityId", async () => {
      const result = await invoke(runtime, {
        action: "create",
        content: "Add tests",
        activeForm: "Adding tests",
      });
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const todo = data.todo as {
        content: string;
        entityId: string;
        status: string;
      };
      expect(todo.content).toBe("Add tests");
      expect(todo.entityId).toBe(ENTITY);
      expect(todo.status).toBe("pending");
    });

    it("requires content", async () => {
      const result = await invoke(runtime, { action: "create" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });
  });

  describe("action=update", () => {
    it("updates content/status by id", async () => {
      await invoke(runtime, {
        action: "create",
        content: "draft",
      });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, {
        action: "update",
        id,
        content: "final",
        status: "in_progress",
      });
      expect(result.success).toBe(true);
      expect(service.rows[0]!.content).toBe("final");
      expect(service.rows[0]!.status).toBe("in_progress");
    });

    it("rejects updates for another user's todo", async () => {
      service.rows.push({
        id: "foreign",
        entityId: "other-user",
        agentId: AGENT,
        roomId: null,
        worldId: null,
        content: "not yours",
        activeForm: "not yours",
        status: "pending",
        parentTodoId: null,
        parentTrajectoryStepId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      });
      const result = await invoke(runtime, {
        action: "update",
        id: "foreign",
        content: "hijacked",
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("not_found");
    });

    it("rejects updates for another agent's todo with the same entityId", async () => {
      service.rows.push({
        id: "foreign-agent",
        entityId: ENTITY,
        agentId: "00000000-0000-0000-0000-0000000000ee",
        roomId: null,
        worldId: null,
        content: "other agent",
        activeForm: "other agent",
        status: "pending",
        parentTodoId: null,
        parentTrajectoryStepId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      });
      const result = await invoke(runtime, {
        action: "update",
        id: "foreign-agent",
        content: "hijacked",
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("not_found");
      expect(service.rows[0]!.content).toBe("other agent");
    });

    it("clears completedAt when a completed todo moves back to pending", async () => {
      await invoke(runtime, { action: "create", content: "reopen me" });
      const id = service.rows[0]!.id;
      await invoke(runtime, { action: "complete", id });
      expect(service.rows[0]!.completedAt).toBeInstanceOf(Date);

      const result = await invoke(runtime, {
        action: "update",
        id,
        status: "pending",
      });

      expect(result.success).toBe(true);
      expect(service.rows[0]!.status).toBe("pending");
      expect(service.rows[0]!.completedAt).toBeNull();
    });
  });

  describe("action=complete / cancel", () => {
    it("complete sets status=completed and completedAt", async () => {
      await invoke(runtime, { action: "create", content: "ship it" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { action: "complete", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]!.status).toBe("completed");
      expect(service.rows[0]!.completedAt).toBeInstanceOf(Date);
    });

    it("cancel sets status=cancelled", async () => {
      await invoke(runtime, { action: "create", content: "drop" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { action: "cancel", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]!.status).toBe("cancelled");
    });
  });

  describe("action=delete", () => {
    it("hard-deletes by id", async () => {
      await invoke(runtime, { action: "create", content: "gone" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { action: "delete", id });
      expect(result.success).toBe(true);
      expect(service.rows.length).toBe(0);
    });
  });

  describe("action=list", () => {
    it("returns user's pending+in_progress by default", async () => {
      await invoke(runtime, { action: "create", content: "a" });
      await invoke(runtime, { action: "create", content: "b" });
      const id = service.rows[1]!.id;
      await invoke(runtime, { action: "complete", id });
      const result = await invoke(runtime, { action: "list" });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });

    it("includeCompleted=true returns everything", async () => {
      await invoke(runtime, { action: "create", content: "a" });
      const id = service.rows[0]!.id;
      await invoke(runtime, { action: "complete", id });
      const result = await invoke(runtime, {
        action: "list",
        includeCompleted: true,
      });
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });
  });

  describe("action=clear", () => {
    it("removes all todos for the user in this room", async () => {
      await invoke(runtime, { action: "create", content: "a" });
      await invoke(runtime, { action: "create", content: "b" });
      const result = await invoke(runtime, { action: "clear" });
      expect(result.success).toBe(true);
      expect(service.rows.length).toBe(0);
    });
  });

  describe("validation", () => {
    it("rejects missing action", async () => {
      const result = await invoke(runtime, {});
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });

    it("rejects unknown action", async () => {
      const result = await invoke(runtime, { action: "destroy" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });

    it("requires entityId on the message", async () => {
      const result = await invoke(
        runtime,
        { action: "list" },
        makeMessage({ entityId: undefined }),
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("entityId");
    });

    it("requires agentId on the runtime", async () => {
      const result = await invoke(
        { ...runtime, agentId: undefined } as never as IAgentRuntime,
        { action: "list" },
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("agentId");
    });
  });

  describe("legacy op discriminator", () => {
    it("accepts legacy op:create for back-compat", async () => {
      const result = await invoke(runtime, {
        op: "create",
        content: "Add tests via legacy name",
      });
      expect(result.success).toBe(true);
      expect(service.rows[0]?.content).toBe("Add tests via legacy name");
    });

    it("accepts legacy subaction:list for back-compat", async () => {
      await invoke(runtime, { action: "create", content: "alpha" });
      const result = await invoke(runtime, { subaction: "list" });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });

    it("keeps op in result data for legacy consumers", async () => {
      const result = await invoke(runtime, {
        action: "create",
        content: "Include legacy result field",
      });
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ action: "create", op: "create" });
    });
  });

  describe("persistence failures", () => {
    it("returns a structured failure when create persistence throws", async () => {
      service.failOn = "create";

      const result = await invoke(runtime, {
        action: "create",
        content: "will fail",
      });

      expect(result.success).toBe(false);
      expect(result.text).toContain("persistence_error");
      expect(result.text).toContain("forced create failure");
      expect(service.rows).toEqual([]);
    });

    it("returns a structured failure when list persistence throws", async () => {
      service.failOn = "list";

      const result = await invoke(runtime, { action: "list" });

      expect(result.success).toBe(false);
      expect(result.text).toContain("persistence_error");
      expect(result.text).toContain("forced list failure");
    });
  });

  describe("currentTodosProvider", () => {
    it("renders only active todos for the current user and agent", async () => {
      await invoke(runtime, { action: "create", content: "pending task" });
      await invoke(runtime, {
        action: "create",
        content: "doing task",
        status: "in_progress",
      });
      await invoke(runtime, {
        action: "create",
        content: "done task",
        status: "completed",
      });
      service.rows.push({
        id: "other-agent",
        entityId: ENTITY,
        agentId: "00000000-0000-0000-0000-0000000000ee",
        roomId: null,
        worldId: null,
        content: "foreign task",
        activeForm: "foreign task",
        status: "pending",
        parentTodoId: null,
        parentTrajectoryStepId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      });

      const result = await currentTodosProvider.get!(
        runtime,
        makeMessage(),
        undefined,
      );

      expect(result.text).toContain("# Current todos");
      expect(result.text).toContain("[ ] pending task");
      expect(result.text).toContain("[→] doing task");
      expect(result.text).not.toContain("done task");
      expect(result.text).not.toContain("foreign task");
      expect((result.data.todos as StoredTodo[]).map((todo) => todo.content))
        .toEqual(["pending task", "doing task"]);
    });

    it("returns empty context when entityId is missing", async () => {
      const result = await currentTodosProvider.get!(
        runtime,
        makeMessage({ entityId: undefined }),
        undefined,
      );

      expect(result).toEqual({ text: "", data: { todos: [] } });
    });
  });
});
