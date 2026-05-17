import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import type { UUID } from "../../../../types/primitives.ts";
import type {
	CreateTodoInput,
	EditTodoInput,
	ListTodosOptions,
	Todo,
} from "../types.ts";

const TODOS_DIR = "todos";

function defaultTodosBasePath(): string {
	return path.join(os.homedir(), ".eliza", TODOS_DIR);
}

function todosFilePath(basePath: string, agentId: UUID, userId: UUID): string {
	const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(basePath, `${safeAgent}_${safeUser}.json`);
}

function readBasePath(runtime: IAgentRuntime | undefined): string {
	const direct = runtime?.getSetting?.("TODOS_BASE_PATH");
	if (typeof direct === "string" && direct.trim()) {
		return direct.trim();
	}
	const envValue = process.env.TODOS_BASE_PATH;
	if (typeof envValue === "string" && envValue.trim()) {
		return envValue.trim();
	}
	return defaultTodosBasePath();
}

type TodoStore = {
	version: 1;
	todos: Todo[];
};

/**
 * Per-user todo list service. Persists to a JSON file per (agentId, userId) pair.
 * Uses an in-memory Map as a write-through cache to avoid repeated disk reads
 * within a single process lifetime.
 */
export class TodosService {
	private readonly basePath: string;
	private readonly cache = new Map<string, Todo[]>();

	constructor(runtime: IAgentRuntime) {
		this.basePath = readBasePath(runtime);
	}

	private storeKey(agentId: UUID, userId: UUID): string {
		return `${agentId}:${userId}`;
	}

	private async ensureDirectory(): Promise<void> {
		await fs.mkdir(this.basePath, { recursive: true });
	}

	private async readStore(agentId: UUID, userId: UUID): Promise<Todo[]> {
		const key = this.storeKey(agentId, userId);
		const cached = this.cache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		await this.ensureDirectory();
		const filePath = todosFilePath(this.basePath, agentId, userId);

		try {
			const raw = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<TodoStore> | null;
			if (!parsed || !Array.isArray(parsed.todos)) {
				return [];
			}
			const todos = parsed.todos.filter(
				(t): t is Todo =>
					t !== null &&
					typeof t === "object" &&
					typeof t.id === "string" &&
					typeof t.agentId === "string" &&
					typeof t.userId === "string" &&
					typeof t.title === "string" &&
					typeof t.status === "string" &&
					typeof t.createdAt === "number",
			);
			this.cache.set(key, todos);
			return todos;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.cache.set(key, []);
				return [];
			}
			logger.warn(
				"[TodosService] Failed to read todos store:",
				error instanceof Error ? error.message : String(error),
			);
			return [];
		}
	}

	private async writeStore(
		agentId: UUID,
		userId: UUID,
		todos: Todo[],
	): Promise<void> {
		await this.ensureDirectory();
		const filePath = todosFilePath(this.basePath, agentId, userId);
		const store: TodoStore = { version: 1, todos };
		const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
		await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
		await fs.rename(tempPath, filePath);
		this.cache.set(this.storeKey(agentId, userId), todos);
	}

	async create(
		agentId: UUID,
		userId: UUID,
		input: CreateTodoInput,
	): Promise<Todo> {
		const todos = await this.readStore(agentId, userId);
		const now = Date.now();
		const todo: Todo = {
			id: crypto.randomUUID() as UUID,
			agentId,
			userId,
			title: input.title.trim(),
			...(input.notes ? { notes: input.notes.trim() } : {}),
			status: "open",
			createdAt: now,
			...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
		};
		todos.unshift(todo);
		await this.writeStore(agentId, userId, todos);
		logger.info(`[TodosService] Created todo ${todo.id}: "${todo.title}"`);
		return todo;
	}

	async complete(agentId: UUID, userId: UUID, id: UUID): Promise<Todo> {
		const todos = await this.readStore(agentId, userId);
		const index = todos.findIndex((t) => t.id === id);
		if (index === -1) {
			throw new Error(`Todo not found: ${id}`);
		}
		const updated: Todo = {
			...todos[index],
			status: "completed",
			completedAt: Date.now(),
		};
		todos[index] = updated;
		await this.writeStore(agentId, userId, todos);
		logger.info(`[TodosService] Completed todo ${id}`);
		return updated;
	}

	async list(
		agentId: UUID,
		userId: UUID,
		opts: ListTodosOptions = {},
	): Promise<Todo[]> {
		const todos = await this.readStore(agentId, userId);
		const statusFilter = opts.status ?? "open";
		const filtered = todos.filter((t) => {
			if (statusFilter === "all") {
				return t.status !== "deleted";
			}
			return t.status === statusFilter;
		});
		const limit = opts.limit;
		return typeof limit === "number" && limit > 0
			? filtered.slice(0, limit)
			: filtered;
	}

	async edit(
		agentId: UUID,
		userId: UUID,
		id: UUID,
		patch: EditTodoInput,
	): Promise<Todo> {
		const todos = await this.readStore(agentId, userId);
		const index = todos.findIndex((t) => t.id === id);
		if (index === -1) {
			throw new Error(`Todo not found: ${id}`);
		}
		const existing = todos[index];
		const updated: Todo = {
			...existing,
			...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
			...(patch.notes !== undefined ? { notes: patch.notes.trim() } : {}),
			...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
			...(patch.status !== undefined ? { status: patch.status } : {}),
		};
		if (patch.status === "completed" && existing.status !== "completed") {
			updated.completedAt = Date.now();
		}
		todos[index] = updated;
		await this.writeStore(agentId, userId, todos);
		logger.info(`[TodosService] Edited todo ${id}`);
		return updated;
	}

	async delete(agentId: UUID, userId: UUID, id: UUID): Promise<boolean> {
		const todos = await this.readStore(agentId, userId);
		const index = todos.findIndex((t) => t.id === id);
		if (index === -1) {
			return false;
		}
		const updated: Todo = { ...todos[index], status: "deleted" };
		todos[index] = updated;
		await this.writeStore(agentId, userId, todos);
		logger.info(`[TodosService] Deleted todo ${id}`);
		return true;
	}
}

const servicesByRuntime = new WeakMap<IAgentRuntime, TodosService>();

export function getTodosService(runtime: IAgentRuntime): TodosService {
	const existing = servicesByRuntime.get(runtime);
	if (existing) {
		return existing;
	}
	const service = new TodosService(runtime);
	servicesByRuntime.set(runtime, service);
	return service;
}
