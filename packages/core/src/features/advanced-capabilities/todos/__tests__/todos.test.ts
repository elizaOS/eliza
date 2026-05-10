import { beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../../types/index.ts";
import { createTodoAction } from "../actions/create-todo.ts";
import { listTodosAction } from "../actions/list-todos.ts";
import { TodosService } from "../services/todoService.ts";

const AGENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID;
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as UUID;

function makeRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getSetting: () => null,
		...overrides,
	} as IAgentRuntime;
}

function makeMessage(
	overrides?: Partial<Memory["content"]>,
	entityId?: UUID,
): Memory {
	return {
		id: "msg-1" as UUID,
		entityId: entityId ?? USER_ID,
		roomId: "room-1" as UUID,
		agentId: AGENT_ID,
		content: {
			text: "",
			...overrides,
		},
	} as Memory;
}

describe("TodosService", () => {
	let service: TodosService;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		// Use a temp path per test via env var override
		runtime = makeRuntime();
		// Redirect to a temp dir via process.env
		const tmpDir = `/tmp/todos-test-${Math.random().toString(36).slice(2)}`;
		process.env.TODOS_BASE_PATH = tmpDir;
		service = new TodosService(runtime);
	});

	it("create returns a todo with correct fields", async () => {
		const todo = await service.create(AGENT_ID, USER_ID, {
			title: "Buy milk",
		});
		expect(todo.id).toBeTruthy();
		expect(todo.title).toBe("Buy milk");
		expect(todo.status).toBe("open");
		expect(todo.agentId).toBe(AGENT_ID);
		expect(todo.userId).toBe(USER_ID);
	});

	it("list returns created todo", async () => {
		await service.create(AGENT_ID, USER_ID, { title: "Task A" });
		const todos = await service.list(AGENT_ID, USER_ID, { status: "open" });
		expect(todos.length).toBeGreaterThanOrEqual(1);
		const found = todos.find((t) => t.title === "Task A");
		expect(found).toBeTruthy();
	});

	it("complete sets status=completed", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "Pay rent",
		});
		const completed = await service.complete(AGENT_ID, USER_ID, created.id);
		expect(completed.status).toBe("completed");
		expect(completed.completedAt).toBeTruthy();
	});

	it("edit changes title", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "Old title",
		});
		const edited = await service.edit(AGENT_ID, USER_ID, created.id, {
			title: "New title",
		});
		expect(edited.title).toBe("New title");
	});

	it("delete removes todo from open list", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "To remove",
		});
		const removed = await service.delete(AGENT_ID, USER_ID, created.id);
		expect(removed).toBe(true);
		const todos = await service.list(AGENT_ID, USER_ID, { status: "open" });
		expect(todos.find((t) => t.id === created.id)).toBeUndefined();
	});

	it("list with status=all includes completed todos", async () => {
		const created = await service.create(AGENT_ID, USER_ID, {
			title: "Done task",
		});
		await service.complete(AGENT_ID, USER_ID, created.id);
		const all = await service.list(AGENT_ID, USER_ID, { status: "all" });
		const found = all.find((t) => t.id === created.id);
		expect(found?.status).toBe("completed");
	});

	it("list respects limit", async () => {
		await service.create(AGENT_ID, USER_ID, { title: "T1" });
		await service.create(AGENT_ID, USER_ID, { title: "T2" });
		await service.create(AGENT_ID, USER_ID, { title: "T3" });
		const limited = await service.list(AGENT_ID, USER_ID, {
			status: "open",
			limit: 2,
		});
		expect(limited.length).toBeLessThanOrEqual(2);
	});
});

describe("createTodoAction handler", () => {
	it("returns success with id when title provided", async () => {
		process.env.TODOS_BASE_PATH = `/tmp/todos-action-${Math.random().toString(36).slice(2)}`;
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);
		const result = await createTodoAction.handler(
			runtime,
			message,
			undefined,
			{ parameters: { title: "Write tests" } },
			undefined,
		);
		expect(result.success).toBe(true);
		expect(result.data?.id).toBeTruthy();
	});

	it("returns failure when no title", async () => {
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);
		const result = await createTodoAction.handler(
			runtime,
			message,
			undefined,
			{},
			undefined,
		);
		expect(result.success).toBe(false);
	});
});

describe("listTodosAction handler", () => {
	it("returns todos after create", async () => {
		process.env.TODOS_BASE_PATH = `/tmp/todos-list-${Math.random().toString(36).slice(2)}`;
		const runtime = makeRuntime();
		const message = makeMessage({}, USER_ID);

		await createTodoAction.handler(
			runtime,
			message,
			undefined,
			{ parameters: { title: "Listed task" } },
			undefined,
		);

		const result = await listTodosAction.handler(
			runtime,
			message,
			undefined,
			{},
			undefined,
		);
		expect(result.success).toBe(true);
		expect((result.data as { count: number })?.count).toBeGreaterThanOrEqual(1);
	});
});
