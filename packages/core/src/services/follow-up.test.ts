/**
 * Tests for FollowUpService lifecycle: completed or stopped follow-ups must
 * never fire through the task scheduler, persisted rows must survive service
 * teardown, and restart must install exactly one live worker. Driven by fake
 * timers over the real TaskService tick loop with an in-memory store.
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
	const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
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
		unregisterTaskWorker: (name: string) => workers.delete(name),
		getServiceLoadPromise: async () => relationshipsService,
		getEntityById: async (id: UUID) =>
			id === ENTITY_ID ? { id, names: ["Test Contact"] } : null,
		createMemory: async (memory: unknown) => {
			memories.push(memory);
		},
		emitEvent: async (event: string, payload: Record<string, unknown>) => {
			events.push({ event, payload });
		},
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
	return {
		runtime,
		tasks,
		workers,
		memories,
		events,
		relationshipsService,
		contact,
	};
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

	it("parks pending rows on stop and executes them exactly once after restart", async () => {
		const { runtime, tasks, workers, memories } = makeRuntime();
		const first = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;
		const task = await first.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"survive relationships reload",
		);
		const liveWorker = workers.get("follow_up");
		expect(liveWorker).toBeDefined();

		await first.stop();
		const parkedWorker = workers.get("follow_up");
		expect(parkedWorker).toBeDefined();
		expect(parkedWorker).not.toBe(liveWorker);
		expect(await parkedWorker?.shouldRun?.(runtime, task)).toBe(false);

		// TaskService's orphan grace has elapsed, but the exact persisted row is
		// retained and the stopped service cannot emit a reminder.
		await vi.advanceTimersByTimeAsync(70_000);
		expect(memories).toHaveLength(0);
		expect(tasks.get(task.id as string)).toEqual(task);

		// Repeated stop is a no-op and must not replace the parking worker.
		await first.stop();
		expect(workers.get("follow_up")).toBe(parkedWorker);

		const restarted = (await FollowUpService.start(runtime)) as FollowUpService;
		expect(workers.get("follow_up")).not.toBe(parkedWorker);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(memories).toHaveLength(1);
		expect(tasks.has(task.id as string)).toBe(false);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(memories).toHaveLength(1);
		await restarted.stop();
	});

	it("fences a captured worker before effects and delivers its row once after restart", async () => {
		const { runtime, tasks, memories, events } = makeRuntime();
		const first = (await FollowUpService.start(runtime)) as FollowUpService;
		service = (await TaskService.start(runtime)) as TaskService;
		const task = await first.scheduleFollowUp(
			ENTITY_ID,
			new Date(T0 + 5_000),
			"survive an in-flight stop",
		);
		const originalRow = structuredClone(task);
		const originalGetEntity = runtime.getEntityById.bind(runtime);
		let entityReads = 0;
		let releaseExecution: (() => void) | null = null;
		const executionBlocked = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		let executionPaused: (() => void) | null = null;
		const paused = new Promise<void>((resolve) => {
			executionPaused = resolve;
		});
		(
			runtime as { getEntityById: IAgentRuntime["getEntityById"] }
		).getEntityById = async (id) => {
			entityReads += 1;
			if (entityReads === 2) {
				executionPaused?.();
				await executionBlocked;
			}
			return originalGetEntity(id);
		};

		const ticking = vi.advanceTimersByTimeAsync(10_000);
		await paused;
		let stopSettled = false;
		const stopping = first.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		expect(stopSettled).toBe(false);

		releaseExecution?.();
		await stopping;
		await ticking;
		expect(memories).toHaveLength(0);
		expect(events).toHaveLength(0);
		expect(tasks.get(task.id as string)).toEqual(originalRow);

		const restarted = (await FollowUpService.start(runtime)) as FollowUpService;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(memories).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(tasks.has(task.id as string)).toBe(false);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(memories).toHaveLength(1);
		expect(events).toHaveLength(1);
		await restarted.stop();
	});

	it("does not remove a newer worker that replaced its owned registration", async () => {
		const { runtime, workers } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;
		const replacement: TaskWorker = {
			name: "follow_up",
			execute: async () => undefined,
		};
		runtime.registerTaskWorker(replacement);

		await followUps.stop();
		await followUps.stop();

		expect(workers.get("follow_up")).toBe(replacement);
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

	it("maintains strict total ordering when scheduledAt metadata contains invalid dates", async () => {
		const { runtime } = makeRuntime();
		const followUps = (await FollowUpService.start(runtime)) as FollowUpService;

		await runtime.createTask({
			name: "Follow up 1",
			tags: ["follow-up"],
			metadata: {
				status: "pending",
				targetEntityId: ENTITY_ID,
				scheduledAt: "2026-01-02T10:00:00.000Z",
			},
		});
		await runtime.createTask({
			name: "Follow up NaN",
			tags: ["follow-up"],
			metadata: {
				status: "pending",
				targetEntityId: ENTITY_ID,
				scheduledAt: "invalid-date-string",
			},
		});
		await runtime.createTask({
			name: "Follow up 2",
			tags: ["follow-up"],
			metadata: {
				status: "pending",
				targetEntityId: ENTITY_ID,
				scheduledAt: "2026-01-03T10:00:00.000Z",
			},
		});

		const upcoming = await followUps.getUpcomingFollowUps();
		expect(upcoming.length).toBe(3);
		expect(upcoming[0]?.task.name).toBe("Follow up NaN"); // fallback 0 scheduled time
		expect(upcoming[1]?.task.name).toBe("Follow up 1");
		expect(upcoming[2]?.task.name).toBe("Follow up 2");
	});
});
