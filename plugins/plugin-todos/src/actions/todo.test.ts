import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  newId(): string {
    this.nextId++;
    return `todo-${this.nextId.toString().padStart(8, "0")}`;
  }

  async create(input: Record<string, unknown>): Promise<StoredTodo> {
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
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async list(filter: {
    entityId: string;
    agentId?: string;
    roomId?: string | null;
    includeCompleted?: boolean;
  }): Promise<StoredTodo[]> {
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
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (patch.content !== undefined) row.content = String(patch.content);
    if (patch.activeForm !== undefined) row.activeForm = String(patch.activeForm);
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
  return {
    agentId: AGENT,
    getSetting: () => undefined,
    getService: (name: string) =>
      name === TODOS_SERVICE_TYPE ? (service as unknown) : null,
  } as unknown as IAgentRuntime;
}

function makeMessage(
  overrides: Partial<Memory> = {},
): Memory {
  return {
    entityId: ENTITY,
    roomId: ROOM,
    worldId: WORLD,
    ...overrides,
  } as unknown as Memory;
}

async function invoke(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  message: Memory = makeMessage(),
) {
  return todoAction.handler!(runtime, message, undefined, { parameters });
}

describe("TODO action", () => {
  let service: FakeTodosService;
  let runtime: IAgentRuntime;

  beforeEach(() => {
    service = new FakeTodosService();
    runtime = mockRuntime(service);
  });

  afterEach(() => {
    delete process.env.MILADY_PARENT_TRAJECTORY_STEP_ID;
  });

  describe("op=write", () => {
    it("writes a mixed list and renders markdown", async () => {
      const result = await invoke(runtime, {
        op: "write",
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
        op: "write",
        todos: [{ content: "original", status: "pending" }],
      });
      const originalId = service.rows[0]!.id;
      const result = await invoke(runtime, {
        op: "write",
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
        op: "write",
        todos: [{ content: "foo", status: "weird" }],
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("invalid_param");
    });

    it("captures parentTrajectoryStepId from env on new rows", async () => {
      process.env.MILADY_PARENT_TRAJECTORY_STEP_ID = "parent-step-99";
      await invoke(runtime, {
        op: "write",
        todos: [{ content: "child task", status: "pending" }],
      });
      expect(service.rows[0]!.parentTrajectoryStepId).toBe("parent-step-99");
    });
  });

  describe("op=create", () => {
    it("creates a single todo scoped to entityId", async () => {
      const result = await invoke(runtime, {
        op: "create",
        content: "Add tests",
        activeForm: "Adding tests",
      });
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const todo = data.todo as { content: string; entityId: string; status: string };
      expect(todo.content).toBe("Add tests");
      expect(todo.entityId).toBe(ENTITY);
      expect(todo.status).toBe("pending");
    });

    it("requires content", async () => {
      const result = await invoke(runtime, { op: "create" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });
  });

  describe("op=update", () => {
    it("updates content/status by id", async () => {
      await invoke(runtime, {
        op: "create",
        content: "draft",
      });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, {
        op: "update",
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
        op: "update",
        id: "foreign",
        content: "hijacked",
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("not_found");
    });
  });

  describe("op=complete / cancel", () => {
    it("complete sets status=completed and completedAt", async () => {
      await invoke(runtime, { op: "create", content: "ship it" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { op: "complete", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]!.status).toBe("completed");
      expect(service.rows[0]!.completedAt).toBeInstanceOf(Date);
    });

    it("cancel sets status=cancelled", async () => {
      await invoke(runtime, { op: "create", content: "drop" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { op: "cancel", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]!.status).toBe("cancelled");
    });
  });

  describe("op=delete", () => {
    it("hard-deletes by id", async () => {
      await invoke(runtime, { op: "create", content: "gone" });
      const id = service.rows[0]!.id;
      const result = await invoke(runtime, { op: "delete", id });
      expect(result.success).toBe(true);
      expect(service.rows.length).toBe(0);
    });
  });

  describe("op=list", () => {
    it("returns user's pending+in_progress by default", async () => {
      await invoke(runtime, { op: "create", content: "a" });
      await invoke(runtime, { op: "create", content: "b" });
      const id = service.rows[1]!.id;
      await invoke(runtime, { op: "complete", id });
      const result = await invoke(runtime, { op: "list" });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });

    it("includeCompleted=true returns everything", async () => {
      await invoke(runtime, { op: "create", content: "a" });
      const id = service.rows[0]!.id;
      await invoke(runtime, { op: "complete", id });
      const result = await invoke(runtime, {
        op: "list",
        includeCompleted: true,
      });
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });
  });

  describe("op=clear", () => {
    it("removes all todos for the user in this room", async () => {
      await invoke(runtime, { op: "create", content: "a" });
      await invoke(runtime, { op: "create", content: "b" });
      const result = await invoke(runtime, { op: "clear" });
      expect(result.success).toBe(true);
      expect(service.rows.length).toBe(0);
    });
  });

  describe("validation", () => {
    it("rejects missing op", async () => {
      const result = await invoke(runtime, {});
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });

    it("rejects unknown op", async () => {
      const result = await invoke(runtime, { op: "destroy" });
      expect(result.success).toBe(false);
      expect(result.text).toContain("missing_param");
    });

    it("requires entityId on the message", async () => {
      const result = await invoke(
        runtime,
        { op: "list" },
        { entityId: undefined, roomId: ROOM } as unknown as Memory,
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("entityId");
    });
  });
});
