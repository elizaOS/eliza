/**
 * Tests for FollowUpService lifecycle: a completed follow-up must never fire
 * through the task scheduler and its completion record must survive. Driven
 * by fake timers over the real TaskService tick loop with an in-memory store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { Task, TaskWorker } from "../types/task";
import { FollowUpService } from "./followUp.ts";
import { TaskService } from "./task.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

function makeRuntime() {
	const tasks = new Map<string, Task>();
	const workers = new Map<string, TaskWorker>();
	const memories: unknown[] = [];
	const noop = () => undefined;
	const contact = {
		entityId: ENTITY_ID,
		names: ["Test Contact"],
		customFields: {} as Record<string, unknown>,
	};
	const relationshipsService = {
		getContact: async () => contact,
		updateContact: async (
			_entityId: UUID,
			patch: { customFields: Record<string, unknown> },
		) => {
			contact.customFields = patch.customFields;
		},
		searchContacts: async () => [contact],
		getRelationshipInsights: async () => ({ needsAttention: [] }),
		analyzeRelationship: async () => null,
	};
	const runtime = {
		agentId: AGENT_ID,
		serverless: false,
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		reportError: vi.fn(),
		registerTaskWorker: (worker: TaskWorker) => {
			workers.set(worker.name, worker);
		},
		getTaskWorker: (name: string) => workers.get(name),
		getServiceLoadPromise: async () => relationshipsService,
		getEntityById: async (id: UUID) =>
			id === ENTITY_ID ? { id, names: ["Test Contact"] } : null,
		createMemory: async (memory: unknown) => {
			memories.push(memory);
		},
		emitEvent: async () => undefined,
		// Honors the requested-tags contract of the real adapters: only tasks
		// carrying EVERY requested tag are returned, so the tests below prove
		// that a completed row actually leaves the scheduler's polling set.
		getTasks: async (params: { tags?: string[]; agentIds?: UUID[] }) =>
			Array.from(tasks.values()).filter((task) =>
				(params.tags ?? []).every((tag) => task.tags?.includes(tag)),
			),
		getTask: async (id: UUID) => tasks.get(id) ?? null,
		getTasksByName: async (name: string) =>
			Array.from(tasks.values()).filter((t) => t.name === name),
		createTask: async (task: Task) => {
			const id = (task.id ?? `task-${tasks.size + 1}`) as UUID;
			tasks.set(id, { ...task, id });
			return id;
		},
		updateTask: async (id: UUID, patch: Partial<Task>) => {
			const existing = tasks.get(id);
			if (!existing) throw new Error(`no task ${id}`);
			tasks.set(id, { ...existing, ...patch });
		},
		updatePendingTask: async (id: UUID, patch: Partial<Task>) => {
			const existing = tasks.get(id);
			if (
				!existing?.tags?.includes("queue") ||
				(existing.metadata?.status != null &&
					existing.metadata.status !== "pending")
			) {
				return false;
			}
			tasks.set(id, { ...existing, ...patch });
			return true;
		},
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
	} as unknown as IAgentRuntime;
	return { runtime, tasks, workers, memories, relationshipsService, contact };
}

describe("FollowUpService completion lifecycle", () => {
	let service: TaskService | null = null;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
	});

	afterEach(async () => {
		if (service) {
			await service.stop();
			service = null;
		}
		vi.useRealTimers();
	});

	it("does not fire a completed follow-up when its due time passes, and keeps the record", async () => {
		const { runtime, tasks, workers, memories } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;

		const task = await followUps.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"check in after intro call",
		);
		expect(workers.has("follow_up")).toBe(true);

		// Operator completes the follow-up before it is due.
		await followUps.completeFollowUp(task.id as UUID);

		// Well past the original due time: no reminder may fire and the
		// completion record must survive the scheduler.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(memories).toHaveLength(0);

		const row = tasks.get(task.id as string);
		expect(row).toBeDefined();
		expect(row?.metadata?.status).toBe("completed");

		await followUps.stop();
	});

	it("still fires a pending follow-up once it is due", async () => {
		const { runtime, tasks, memories } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;

		const task = await followUps.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"pending control",
		);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(memories).toHaveLength(1);
		expect(tasks.has(task.id as string)).toBe(false);

		await followUps.stop();
	});

	it("does not fire a completed row that still carries the queue tag (legacy storage)", async () => {
		const { runtime, tasks, memories } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;

		// A row persisted by an older build: completed but never unqueued.
		tasks.set("legacy-completed", {
			id: "legacy-completed" as UUID,
			name: "follow_up",
			agentId: AGENT_ID,
			tags: ["follow-up", "queue"],
			dueAt: T0 + 5_000,
			metadata: {
				targetEntityId: ENTITY_ID,
				reason: "legacy",
				status: "completed",
			},
		});

		await vi.advanceTimersByTimeAsync(30_000);
		expect(memories).toHaveLength(0);
		const row = tasks.get("legacy-completed");
		expect(row?.metadata?.status).toBe("completed");

		await followUps.stop();
	});

	it("retries contact cleanup after task completion already persisted", async () => {
		const { runtime, tasks, memories, relationshipsService, contact } =
			makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;
		const task = await followUps.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"contact cleanup retry",
		);

		const realUpdateContact = relationshipsService.updateContact;
		let failCleanup = true;
		relationshipsService.updateContact = async (entityId, patch) => {
			if (failCleanup) {
				failCleanup = false;
				throw new Error("contact store unavailable");
			}
			await realUpdateContact(entityId, patch);
		};

		await expect(
			followUps.completeFollowUp(task.id as UUID, "handled"),
		).rejects.toThrow("contact store unavailable");
		expect(tasks.get(task.id as string)?.metadata?.status).toBe("completed");
		expect(contact.customFields.nextFollowUpAt).toBeDefined();

		await followUps.completeFollowUp(task.id as UUID, "handled");
		expect(contact.customFields.nextFollowUpAt).toBeUndefined();
		expect(contact.customFields.nextFollowUpReason).toBeUndefined();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(memories).toHaveLength(0);
		expect(tasks.has(task.id as string)).toBe(true);

		await followUps.stop();
	});

	it("does not fire or delete when completion wins after a stale tick selection", async () => {
		const { runtime, tasks, memories } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;

		const task = await followUps.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"completion race window",
		);
		await vi.advanceTimersByTimeAsync(1_000);

		const realTransition = runtime.updatePendingTask.bind(runtime);
		let releaseClaim: (() => void) | null = null;
		const claimBlocked = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		let claimAttempted: (() => void) | null = null;
		const attempted = new Promise<void>((resolve) => {
			claimAttempted = resolve;
		});
		(
			runtime as { updatePendingTask: IAgentRuntime["updatePendingTask"] }
		).updatePendingTask = async (id, patch) => {
			if (patch.metadata?.status === "executing") {
				claimAttempted?.();
				await claimBlocked;
			}
			return realTransition(id, patch);
		};

		const ticking = vi.advanceTimersByTimeAsync(10_000);
		await attempted;
		await followUps.completeFollowUp(task.id as UUID, "handled early");
		const stored = tasks.get(task.id as string);
		expect(stored?.tags?.includes("queue")).toBe(false);
		expect(stored?.metadata?.status).toBe("completed");

		releaseClaim?.();
		await ticking;
		expect(memories).toHaveLength(0);
		expect(tasks.has(task.id as string)).toBe(true);

		// Every subsequent poll observes the retired state: no further fires.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(memories).toHaveLength(0);

		await followUps.stop();
	});
});

describe("FollowUpService suggestion completeness", () => {
	it("returns every qualifying suggestion in priority order", async () => {
		const contacts = Array.from({ length: 12 }, (_, index) => ({
			entityId:
				`00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
			categories: [],
		}));
		const relationshipsService = {
			searchContacts: async () => contacts,
			getRelationshipInsights: async () => ({
				needsAttention: contacts.map((contact, index) => ({
					entity: { id: contact.entityId },
					daysSinceContact: 20 + index,
				})),
			}),
			analyzeRelationship: async () => ({ strength: 50 }),
		};
		const runtime = {
			agentId: AGENT_ID,
			getEntityById: async (id: UUID) => ({ id, names: [`Contact ${id}`] }),
		};
		const followUps = new FollowUpService(runtime as never);
		(
			followUps as unknown as {
				relationshipsService: typeof relationshipsService;
			}
		).relationshipsService = relationshipsService;

		const suggestions = await followUps.getFollowUpSuggestions();

		expect(suggestions).toHaveLength(12);
		expect(suggestions.map((item) => item.daysSinceLastContact)).toEqual(
			Array.from({ length: 12 }, (_, index) => 31 - index),
		);
	});
});
