import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { ServiceType } from "../types/service";
import type { Task, TaskWorker } from "../types/task";
import { TaskService } from "./task.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

/**
 * In-memory task store + minimal runtime for TaskService.
 * updateTask replaces metadata (executeTask always writes the full new metadata object).
 * Deliberately does NOT auto-markDirty on mutation — the tests below exercise
 * exactly when the tick re-queries without external nudges.
 */
function makeTaskRuntime() {
	const tasks = new Map<string, Task>();
	const workers = new Map<string, TaskWorker>();
	const noop = () => undefined;
	const runtime = {
		agentId: AGENT_ID,
		serverless: false,
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		registerTaskWorker: (worker: TaskWorker) => {
			workers.set(worker.name, worker);
		},
		getTaskWorker: (name: string) => workers.get(name),
		getTasks: async (_params: { tags?: string[]; agentIds?: UUID[] }) =>
			Array.from(tasks.values()),
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
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
	} as unknown as IAgentRuntime;
	return { runtime, tasks, workers };
}

describe("TaskService tick re-arm", () => {
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

	it("executes a repeat task on every interval, not just once at boot", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("HEARTBEAT", { name: "HEARTBEAT", execute });
		tasks.set("t-repeat", {
			id: "t-repeat" as UUID,
			name: "HEARTBEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 60_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// First tick happens at +1s, long before the task is due. Without the
		// re-arm the dirty gate would disarm here and the task would never run.
		await vi.advanceTimersByTimeAsync(61_000);
		expect(execute).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(execute).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("runs a task created after the tick disarmed on an empty queue once markDirty is called", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("ONE_SHOT", { name: "ONE_SHOT", execute });

		service = (await TaskService.start(runtime)) as TaskService;

		// First tick sees an EMPTY queue and disarms — that is the one case
		// where staying quiet is correct.
		await vi.advanceTimersByTimeAsync(2_000);
		expect(execute).not.toHaveBeenCalled();

		tasks.set("t-late", {
			id: "t-late" as UUID,
			name: "ONE_SHOT",
			agentId: AGENT_ID,
			tags: ["queue"],
			metadata: {},
		});

		// The store mutation alone is invisible to the disarmed tick.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(execute).not.toHaveBeenCalled();

		// markDirty (what runtime.createTask now calls) re-arms the tick.
		service.markDirty();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(tasks.has("t-late")).toBe(false); // one-shots delete after running
	});

	it("keeps seeing repeat tasks that only become due after several quiet ticks (no markDirty ever)", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => undefined);
		workers.set("SLOW_REPEAT", { name: "SLOW_REPEAT", execute });
		tasks.set("t-slow", {
			id: "t-slow" as UUID,
			name: "SLOW_REPEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			// Mirrors the LifeOps heartbeat shape: interval + boot jitter means
			// the first tick always lands before the task is due.
			metadata: { updateInterval: 65_000, baseInterval: 65_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		await vi.advanceTimersByTimeAsync(10 * 60_000);
		// 600s / 65s interval => 9 executions; allow scheduling slack of one.
		expect(execute.mock.calls.length).toBeGreaterThanOrEqual(8);
	});

	it("never auto-pauses a repeat task with maxFailures <= 0", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => {
			throw new Error("boom");
		});
		workers.set("FLAKY_HEARTBEAT", { name: "FLAKY_HEARTBEAT", execute });
		tasks.set("t-flaky", {
			id: "t-flaky" as UUID,
			name: "FLAKY_HEARTBEAT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: {
				updateInterval: 1_000,
				baseInterval: 1_000,
				updatedAt: T0,
				maxFailures: 0,
			},
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Failure backoff doubles the interval each time: runs land at
		// +1s, +3s, +7s, +15s, +31s, +63s, +127s => 7 failures in 128s.
		await vi.advanceTimersByTimeAsync(128_000);

		expect(execute.mock.calls.length).toBeGreaterThan(5);
		const meta = tasks.get("t-flaky")?.metadata;
		expect(meta?.paused).not.toBe(true);
		expect(meta?.failureCount).toBe(execute.mock.calls.length);
		expect(meta?.lastError).toBe("boom");
	});

	it("still auto-pauses a repeat task after 5 consecutive failures by default", async () => {
		const { runtime, tasks, workers } = makeTaskRuntime();
		const execute = vi.fn(async () => {
			throw new Error("boom");
		});
		workers.set("FLAKY_DEFAULT", { name: "FLAKY_DEFAULT", execute });
		tasks.set("t-default", {
			id: "t-default" as UUID,
			name: "FLAKY_DEFAULT",
			agentId: AGENT_ID,
			tags: ["queue", "repeat"],
			metadata: { updateInterval: 1_000, baseInterval: 1_000, updatedAt: T0 },
		});

		service = (await TaskService.start(runtime)) as TaskService;

		// Runs land at +1s, +3s, +7s, +15s, +31s => paused after the 5th failure.
		await vi.advanceTimersByTimeAsync(40_000);
		expect(execute).toHaveBeenCalledTimes(5);
		expect(tasks.get("t-default")?.metadata?.paused).toBe(true);

		// Paused task stays paused: no further executions.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(execute).toHaveBeenCalledTimes(5);
	});
});

describe("AgentRuntime task mutations mark the local TaskService dirty", () => {
	function makeRuntimeShell() {
		const markDirty = vi.fn();
		const getService = vi.fn((type: string) =>
			type === ServiceType.TASK ? { markDirty } : null,
		);
		const adapter = {
			createTasks: vi.fn(async (tasks: Task[]) =>
				tasks.map((_, i) => `id-${i}` as UUID),
			),
			updateTasks: vi.fn(async () => undefined),
			deleteTasks: vi.fn(async () => undefined),
		};
		// Prototype-backed shell: exercises the real createTask/updateTask/deleteTask
		// implementations without booting a full AgentRuntime.
		const runtime = Object.assign(Object.create(AgentRuntime.prototype), {
			agentId: AGENT_ID,
			adapter,
			getService,
			companionUrl: undefined,
		}) as AgentRuntime;
		return { runtime, markDirty, adapter };
	}

	it("createTask nudges the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.createTask({ name: "X" });
		expect(markDirty).toHaveBeenCalledTimes(1);
	});

	it("updateTask and deleteTask nudge the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.updateTask("id-0" as UUID, { metadata: {} });
		await runtime.deleteTask("id-0" as UUID);
		expect(markDirty).toHaveBeenCalledTimes(2);
	});

	it("batch createTasks/updateTasks/deleteTasks nudge the TASK service", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		await runtime.createTasks([{ name: "A" }, { name: "B" }]);
		await runtime.updateTasks([{ id: "id-0" as UUID, task: {} }]);
		await runtime.deleteTasks(["id-0" as UUID]);
		expect(markDirty).toHaveBeenCalledTimes(3);
	});

	it("does not throw when no TaskService is registered", async () => {
		const { runtime, markDirty } = makeRuntimeShell();
		(runtime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
		await expect(runtime.createTask({ name: "X" })).resolves.toBeDefined();
		expect(markDirty).not.toHaveBeenCalled();
	});
});
