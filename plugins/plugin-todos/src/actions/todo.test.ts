/**
 * Todo action tests cover the TODO umbrella action and CURRENT_TODOS provider
 * against a deterministic in-memory service with no live database.
 */
import type {
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { currentTodosProvider } from "../providers/current-todos.js";
import { TODO_LIST_LIMIT_ERROR_CODE, TodosService } from "../service.js";
import type {
  TodoMutationExecution,
  TodoMutationInput,
  TodoScope,
} from "../store.js";
import { TODOS_SERVICE_TYPE, type TodoStatus } from "../types.js";
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
  status: TodoStatus;
  parentTodoId: string | null;
  parentTrajectoryStepId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

class FakeTodosService {
  private nextId = 0;
  private mutationLedger = new Map<
    string,
    { request: string; execution: TodoMutationExecution }
  >();
  rows: StoredTodo[] = [];
  failOn: string | null = null;
  listCallCount = 0;

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
      status: (input.status ?? "pending") as TodoStatus,
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

  async get(scope: TodoScope, id: string): Promise<StoredTodo | null> {
    this.throwIf("get");
    return (
      this.rows.find(
        (row) =>
          row.id === id &&
          row.agentId === scope.agentId &&
          row.entityId === scope.entityId,
      ) ?? null
    );
  }

  async list(filter: {
    entityId: string;
    agentId: string;
    roomId?: string | null;
    includeCompleted?: boolean;
    limit?: number;
  }): Promise<StoredTodo[]> {
    this.listCallCount++;
    this.throwIf("list");
    let results = this.rows.filter((r) => {
      if (r.entityId !== filter.entityId) return false;
      if (r.agentId !== filter.agentId) return false;
      if (filter.roomId && r.roomId !== filter.roomId) return false;
      if (
        filter.includeCompleted === false &&
        (r.status === "completed" || r.status === "cancelled")
      ) {
        return false;
      }
      return true;
    });
    if (filter.limit !== undefined) {
      results = results.slice(0, filter.limit);
    }
    return results;
  }

  async update(
    scope: TodoScope,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<StoredTodo | null> {
    this.throwIf("update");
    const row = this.rows.find(
      (candidate) =>
        candidate.id === id &&
        candidate.agentId === scope.agentId &&
        candidate.entityId === scope.entityId,
    );
    if (!row) return null;
    if (patch.content !== undefined) row.content = String(patch.content);
    if (patch.activeForm !== undefined)
      row.activeForm = String(patch.activeForm);
    if (patch.status !== undefined) {
      row.status = String(patch.status) as TodoStatus;
      row.completedAt = row.status === "completed" ? new Date() : null;
    }
    if (patch.parentTodoId !== undefined) {
      row.parentTodoId = (patch.parentTodoId as string | null) ?? null;
    }
    row.updatedAt = new Date();
    return row;
  }

  async delete(scope: TodoScope, id: string): Promise<boolean> {
    this.throwIf("delete");
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (row) =>
        row.id !== id ||
        row.agentId !== scope.agentId ||
        row.entityId !== scope.entityId,
    );
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
      status: TodoStatus;
      activeForm?: string;
    }>;
  }): Promise<{ before: StoredTodo[]; after: StoredTodo[] }> {
    this.throwIf("writeList");
    const before = (
      await this.list({
        entityId: args.entityId,
        agentId: args.agentId,
      })
    ).map((todo) => ({ ...todo }));
    const beforeById = new Map(before.map((t) => [t.id, t]));
    const keep = new Set<string>();
    const after: StoredTodo[] = [];
    for (const item of args.todos) {
      const existing = item.id ? beforeById.get(item.id) : undefined;
      if (existing) {
        keep.add(existing.id);
        const updated = await this.update(args, existing.id, {
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
      return keep.has(r.id);
    });
    return { before, after };
  }

  async clear(filter: {
    entityId: string;
    agentId: string;
    roomId?: string | null;
  }): Promise<number> {
    this.throwIf("clear");
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => {
      if (r.entityId !== filter.entityId) return true;
      if (r.agentId !== filter.agentId) return true;
      if (filter.roomId && r.roomId !== filter.roomId) return true;
      return false;
    });
    return before - this.rows.length;
  }

  async applyMutation(
    input: TodoMutationInput,
  ): Promise<TodoMutationExecution> {
    const ledgerKey = `${input.scope.agentId}:${input.scope.entityId}:${input.idempotencyKey}`;
    const request = JSON.stringify(input.mutation);
    const existing = this.mutationLedger.get(ledgerKey);
    if (existing) {
      if (existing.request !== request) throw new Error("idempotency conflict");
      return structuredClone({ ...existing.execution, replayed: true });
    }

    let result: TodoMutationExecution["result"];
    switch (input.mutation.action) {
      case "create":
        result = {
          action: input.mutation.action,
          todo: await this.create({
            ...input.mutation.input,
            ...input.scope,
          }),
        };
        break;
      case "update":
        result = {
          action: input.mutation.action,
          todo: await this.update(
            input.scope,
            input.mutation.id,
            input.mutation.patch,
          ),
        };
        break;
      case "complete":
      case "cancel":
        result = {
          action: input.mutation.action,
          todo: await this.update(input.scope, input.mutation.id, {
            status:
              input.mutation.action === "complete" ? "completed" : "cancelled",
          }),
        };
        break;
      case "delete": {
        const deleted = await this.get(input.scope, input.mutation.id);
        if (deleted) await this.delete(input.scope, input.mutation.id);
        result = { action: input.mutation.action, deleted };
        break;
      }
      case "write": {
        const list = await this.writeList({
          ...input.mutation.input,
          ...input.scope,
        });
        result = { action: input.mutation.action, ...list };
        break;
      }
      case "clear":
        result = {
          action: input.mutation.action,
          count: await this.clear({
            ...input.scope,
            ...(input.mutation.roomId !== undefined
              ? { roomId: input.mutation.roomId }
              : {}),
          }),
        };
        break;
    }
    const applied =
      result.action === "create" ||
      ((result.action === "update" ||
        result.action === "complete" ||
        result.action === "cancel") &&
        result.todo !== null) ||
      (result.action === "delete" && result.deleted !== null) ||
      (result.action === "write" &&
        JSON.stringify(
          result.before.map(({ updatedAt: _updatedAt, ...todo }) => todo),
        ) !==
          JSON.stringify(
            result.after.map(({ updatedAt: _updatedAt, ...todo }) => todo),
          )) ||
      (result.action === "clear" && result.count > 0);
    const execution: TodoMutationExecution = {
      mutationId: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      replayed: false,
      committedAt: new Date(),
      applied,
      result,
    };
    this.mutationLedger.set(ledgerKey, {
      request,
      execution: structuredClone(execution),
    });
    return execution;
  }

  async listMutationRecords(): Promise<[]> {
    return [];
  }

  async readCutoverState(): Promise<{ todos: StoredTodo[]; mutations: [] }> {
    return { todos: structuredClone(this.rows), mutations: [] };
  }

  async importMutationRecords(): Promise<{
    imported: number;
    skipped: number;
  }> {
    return { imported: 0, skipped: 0 };
  }
}

function mockRuntime(service: FakeTodosService): IAgentRuntime {
  const stub = {
    agentId: AGENT,
    getSetting: (key: string): string | boolean | number | null =>
      process.env[key] ?? null,
    getService: ((name: string) =>
      name === TODOS_SERVICE_TYPE
        ? service
        : null) as IAgentRuntime["getService"],
  };
  return stub as never as IAgentRuntime;
}

let messageSequence = 0;

function makeMessage(overrides: Partial<Memory> = {}): Memory {
  messageSequence++;
  return {
    id: `message-${messageSequence}`,
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
  options: Partial<HandlerOptions> = {},
): Promise<ActionResult> {
  const opts = { ...options, parameters } as HandlerOptions;
  const result = await todoAction.handler?.(runtime, message, undefined, opts);
  if (result === undefined) {
    throw new Error("todoAction.handler returned undefined");
  }
  return result;
}

function expectAppliedMutation(
  result: ActionResult,
  action: string,
  resourceId?: string,
): void {
  expect(result.success).toBe(true);
  expect(result.verifiedUserFacing).toBe(true);
  expect(result.userFacingText).toBe(result.text);
  expect(result.turnComplete).toBe(true);
  expect(result.continueChain).toBe(false);
  expect(result.data).toMatchObject({ actionName: "TODO", action, op: action });
  expect(result.effectReceipts).toHaveLength(1);
  const receipt = result.effectReceipts?.[0];
  expect(receipt).toMatchObject({
    operation: `todos.${action}`,
    outcome: "applied",
    artifacts: [],
    idempotency: {
      key: expect.stringMatching(/^todos:v1:/),
      replayed: false,
    },
    ...(resourceId ? { resource: { id: resourceId } } : {}),
  });
  if (receipt?.outcome !== "applied") {
    throw new Error("Expected one applied Todo mutation receipt.");
  }
  expect(receipt.commit.kind).toBe("durable");
  expect(receipt.commit.committedAt).toBe(receipt.observedAt);
  expect(Number.isNaN(Date.parse(receipt.observedAt))).toBe(false);
  expect(result.userFacingEffectReceiptIds).toEqual([receipt.receiptId]);
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

  describe("verified mutation receipts", () => {
    it("binds every durable mutation to its exact applied receipt", async () => {
      const write = await invoke(runtime, {
        action: "write",
        todos: [{ content: "written", status: "pending" }],
      });
      expectAppliedMutation(write, "write", `${AGENT}:${ENTITY}`);

      const create = await invoke(runtime, {
        action: "create",
        content: "created",
      });
      const todoId = service.rows.at(-1)?.id;
      if (!todoId) throw new Error("Create must return a durable todo id.");
      expectAppliedMutation(create, "create", todoId);

      expectAppliedMutation(
        await invoke(runtime, {
          action: "update",
          id: todoId,
          content: "updated",
        }),
        "update",
        todoId,
      );
      expectAppliedMutation(
        await invoke(runtime, { action: "complete", id: todoId }),
        "complete",
        todoId,
      );
      expectAppliedMutation(
        await invoke(runtime, { action: "cancel", id: todoId }),
        "cancel",
        todoId,
      );
      expectAppliedMutation(
        await invoke(runtime, { action: "delete", id: todoId }),
        "delete",
        todoId,
      );
      expectAppliedMutation(
        await invoke(runtime, { action: "clear" }),
        "clear",
        `${AGENT}:${ENTITY}`,
      );
    });

    it("keeps reads and zero-change clears receipt-free", async () => {
      const list = await invoke(runtime, { action: "list" });
      expect(list.data).toMatchObject({ actionName: "TODO", action: "list" });
      expect(list.effectReceipts).toBeUndefined();
      expect(list.userFacingEffectReceiptIds).toBeUndefined();

      const clear = await invoke(runtime, { action: "clear" });
      expect(clear.data).toMatchObject({
        actionName: "TODO",
        action: "clear",
        count: 0,
      });
      expect(clear.effectReceipts).toBeUndefined();
      expect(clear.verifiedUserFacing).toBeUndefined();
      expect(clear.turnComplete).toBe(true);
      expect(clear.continueChain).toBe(false);
    });

    it("replays one committed mutation with a stable noop receipt", async () => {
      const message = makeMessage({
        content: {
          text: "add it",
          chatIdempotency: { clientMessageId: "connector-message-1" },
        },
      });
      const first = await invoke(
        runtime,
        { action: "create", content: "only once" },
        message,
      );
      const replay = await invoke(
        runtime,
        { action: "create", content: "only once" },
        message,
      );

      expect(service.rows).toHaveLength(1);
      expect(replay.text).toBe(first.text);
      expect(replay.data).toEqual(first.data);
      expect(replay.continueChain).toBe(false);
      expect(replay.effectReceipts?.[0]).toMatchObject({
        receiptId: first.effectReceipts?.[0]?.receiptId,
        outcome: "noop",
        reason: "Reused the previously committed Todo mutation",
        idempotency: {
          key: "todos:v1:connector-message-1:0",
          replayed: true,
        },
      });
      expect(replay.effectReceipts?.[0]).not.toHaveProperty("commit");
    });

    it("conflicts instead of applying a changed retry plan", async () => {
      const message = makeMessage({ id: "same-memory-id" });
      await invoke(runtime, { action: "create", content: "original" }, message);
      const changed = await invoke(
        runtime,
        { action: "create", content: "changed" },
        message,
      );

      expect(changed.success).toBe(false);
      expect(changed.text).toContain("idempotency conflict");
      expect(changed.continueChain).toBe(false);
      expect(service.rows.map((todo) => todo.content)).toEqual(["original"]);
    });

    it("counts prior Todo mutations but ignores reads and unrelated tools", async () => {
      const previousResults: ActionResult[] = [
        { success: true, data: { actionName: "SEARCH", action: "search" } },
        {
          success: true,
          data: { actionName: "TODO", action: "list", op: "list" },
        },
        {
          success: true,
          data: { actionName: "TODO", action: "create", op: "create" },
        },
      ];
      const result = await invoke(
        runtime,
        { action: "create", content: "second mutation" },
        makeMessage({
          content: {
            text: "add another",
            chatIdempotency: { clientMessageId: "connector-message-2" },
          },
        }),
        { actionContext: { previousResults } },
      );

      expect(result.effectReceipts?.[0]?.idempotency.key).toBe(
        "todos:v1:connector-message-2:1",
      );
      expect(result.continueChain).toBe(false);
    });
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
      const originalId = service.rows[0]?.id;
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

    it("reconciles the entity-scoped list across rooms", async () => {
      const otherRoom = "11111111-2222-4333-8444-555555555555";
      const existing = await service.create({
        entityId: ENTITY,
        agentId: AGENT,
        roomId: otherRoom,
        worldId: null,
        content: "cross-room task",
        status: "pending",
      });

      const result = await invoke(runtime, {
        action: "write",
        todos: [
          {
            id: existing.id,
            content: existing.content,
            status: "completed",
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(service.rows).toHaveLength(1);
      expect(service.rows[0]).toMatchObject({
        id: existing.id,
        roomId: otherRoom,
        status: "completed",
      });
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
      expect(service.rows[0]?.parentTrajectoryStepId).toBe("parent-step-99");
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
          { id: charlie?.id, content: "charlie next", status: "in_progress" },
          { content: "delta", status: "pending" },
          { id: alpha?.id, content: "alpha done", status: "completed" },
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
      const id = service.rows[0]?.id;
      const result = await invoke(runtime, {
        action: "update",
        id,
        content: "final",
        status: "in_progress",
      });
      expect(result.success).toBe(true);
      expect(service.rows[0]?.content).toBe("final");
      expect(service.rows[0]?.status).toBe("in_progress");
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
      expect(service.rows[0]?.content).toBe("other agent");
    });

    it("clears completedAt when a completed todo moves back to pending", async () => {
      await invoke(runtime, { action: "create", content: "reopen me" });
      const id = service.rows[0]?.id;
      await invoke(runtime, { action: "complete", id });
      expect(service.rows[0]?.completedAt).toBeInstanceOf(Date);

      const result = await invoke(runtime, {
        action: "update",
        id,
        status: "pending",
      });

      expect(result.success).toBe(true);
      expect(service.rows[0]?.status).toBe("pending");
      expect(service.rows[0]?.completedAt).toBeNull();
    });

    it("detaches a todo from its parent when detachParent is true", async () => {
      await invoke(runtime, { action: "create", content: "parent" });
      const parentId = service.rows[0]?.id;
      await invoke(runtime, {
        action: "create",
        content: "child",
        parentTodoId: parentId,
      });
      const childId = service.rows[1]?.id;
      expect(service.rows[1]?.parentTodoId).toBe(parentId);

      const result = await invoke(runtime, {
        action: "update",
        id: childId,
        detachParent: true,
      });

      expect(result.success).toBe(true);
      expect(service.rows[1]?.parentTodoId).toBeNull();
    });
  });

  describe("action=complete / cancel", () => {
    it("complete sets status=completed and completedAt", async () => {
      await invoke(runtime, { action: "create", content: "ship it" });
      const id = service.rows[0]?.id;
      const result = await invoke(runtime, { action: "complete", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]?.status).toBe("completed");
      expect(service.rows[0]?.completedAt).toBeInstanceOf(Date);
    });

    it("cancel sets status=cancelled", async () => {
      await invoke(runtime, { action: "create", content: "drop" });
      const id = service.rows[0]?.id;
      const result = await invoke(runtime, { action: "cancel", id });
      expect(result.success).toBe(true);
      expect(service.rows[0]?.status).toBe("cancelled");
    });
  });

  describe("action=delete", () => {
    it("hard-deletes by id", async () => {
      await invoke(runtime, { action: "create", content: "gone" });
      const id = service.rows[0]?.id;
      const result = await invoke(runtime, { action: "delete", id });
      expect(result.success).toBe(true);
      expect(service.rows.length).toBe(0);
    });
  });

  describe("action=list", () => {
    it("returns user's pending+in_progress by default", async () => {
      await invoke(runtime, { action: "create", content: "a" });
      await invoke(runtime, { action: "create", content: "b" });
      const id = service.rows[1]?.id;
      await invoke(runtime, { action: "complete", id });
      const result = await invoke(runtime, { action: "list" });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(1);
    });

    it("includeCompleted=true returns everything", async () => {
      await invoke(runtime, { action: "create", content: "a" });
      const id = service.rows[0]?.id;
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

  describe("action=list limit validation", () => {
    beforeEach(async () => {
      // Create 5 todos for limit testing
      for (let i = 1; i <= 5; i++) {
        await invoke(runtime, {
          action: "create",
          content: `task ${i}`,
          status: "pending",
        });
      }
    });

    it("accepts positive integer limit and returns capped results", async () => {
      const result = await invoke(runtime, {
        action: "list",
        limit: 3,
      });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(3);
    });

    it("rejects unsafe limits at the planner boundary before persistence", () => {
      const accepted = validateToolArgs(todoAction, {
        action: "list",
        limit: Number.MAX_SAFE_INTEGER,
      });
      const rejected = validateToolArgs(todoAction, {
        action: "list",
        limit: Number.MAX_SAFE_INTEGER + 1,
      });

      expect(accepted.valid).toBe(true);
      expect(accepted.args).toEqual({
        action: "list",
        limit: Number.MAX_SAFE_INTEGER,
      });
      expect(rejected.valid).toBe(false);
      expect(rejected.args).toBeUndefined();
      expect(rejected.invalidParameterNames).toEqual(["limit"]);
      expect(service.listCallCount).toBe(0);
    });

    it("omitted limit returns all results (unlimited)", async () => {
      const result = await invoke(runtime, { action: "list" });
      expect(result.success).toBe(true);
      const data = result.data as { todos: unknown[] };
      expect(data.todos.length).toBe(5);
      expect(service.listCallCount).toBe(1);
    });

    it("reads a supplied limit once before validation and use", async () => {
      let reads = 0;
      const parameters = {
        action: "list",
        get limit() {
          reads += 1;
          return reads === 1 ? 1 : undefined;
        },
      };

      const result = await invoke(runtime, parameters);

      expect(result.success).toBe(true);
      expect((result.data as { todos: unknown[] }).todos).toHaveLength(1);
      expect(reads).toBe(1);
    });

    it.each([
      ["zero", 0],
      ["negative", -5],
      ["fraction", 2.5],
      ["NaN", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
      ["numeric string", "3"],
      ["non-numeric string", "abc"],
      ["null", null],
      ["boolean", false],
      ["explicit undefined", undefined],
    ])(
      "rejects a supplied %s before calling the service",
      async (_name, limit) => {
        const result = await invoke(runtime, {
          action: "list",
          limit,
        });
        expect(result.success).toBe(false);
        expect(result.text).toContain("invalid_param");
        expect(result.text).toContain("positive safe integer number");
        expect(service.listCallCount).toBe(0);
      },
    );
  });

  describe("TodosService.list limit validation", () => {
    it("uses the same single-read limit value for the database query", async () => {
      let reads = 0;
      const limit = vi.fn(async () => []);
      const orderBy = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      const directService = new TodosService({
        db: { select },
      } as unknown as IAgentRuntime);
      const filter = {
        entityId: ENTITY,
        get limit() {
          reads += 1;
          return reads === 1 ? 1 : undefined;
        },
      };

      await directService.list(filter);

      expect(reads).toBe(1);
      expect(limit).toHaveBeenCalledWith(1);
    });

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["fraction", 1.5],
      ["NaN", Number.NaN],
      ["numeric string", "2"],
      ["explicit undefined", undefined],
    ])(
      "rejects a supplied %s before reading the database",
      async (_name, limit) => {
        const select = vi.fn();
        const directService = new TodosService({
          db: { select },
        } as unknown as IAgentRuntime);

        await expect(
          directService.list({
            entityId: ENTITY,
            limit: limit as number,
          }),
        ).rejects.toMatchObject({
          name: "ElizaError",
          code: TODO_LIST_LIMIT_ERROR_CODE,
        });
        expect(select).not.toHaveBeenCalled();
      },
    );
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

      const result = await currentTodosProvider.get?.(
        runtime,
        makeMessage(),
        undefined,
      );

      expect(result.text).toContain("# Current todos");
      expect(result.text).toContain("[ ] pending task");
      expect(result.text).toContain("[→] doing task");
      expect(result.text).not.toContain("done task");
      expect(result.text).not.toContain("foreign task");
      expect(
        (result.data.todos as StoredTodo[]).map((todo) => todo.content),
      ).toEqual(["pending task", "doing task"]);
    });

    it("returns empty context when entityId is missing", async () => {
      const result = await currentTodosProvider.get?.(
        runtime,
        makeMessage({ entityId: undefined }),
        undefined,
      );

      expect(result).toEqual({ text: "", data: { todos: [] } });
    });
  });
});
