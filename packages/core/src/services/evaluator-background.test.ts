/** Durable handoff and room ownership through real runtime/task/cache adapters. */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { factMemoryEvaluator } from "../features/advanced-capabilities/evaluators/reflection-items";
import { AgentRuntime } from "../runtime";
import {
	ChannelType,
	type Character,
	type Memory,
	type RegisteredEvaluator,
	type State,
	type Task,
} from "../types";
import { EvaluatorService } from "./evaluator";

const state: State = { values: {}, data: {}, text: "" };
const turn: Memory = {
	id: "00000000-0000-4000-8000-000000000001",
	roomId: "00000000-0000-4000-8000-000000000002",
	entityId: "00000000-0000-4000-8000-000000000003",
	content: { text: "I live in Berlin." },
	createdAt: 10,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function setup(adapter = new InMemoryDatabaseAdapter()) {
	const runtime = new AgentRuntime({
		character: {
			name: "BackgroundMemoryTest",
			bio: "test",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async () => state);
	runtime.emitEvent = vi.fn(async () => {});
	await runtime.createRooms([
		{
			id: turn.roomId,
			agentId: runtime.agentId,
			type: ChannelType.DM,
			source: "test",
		},
	]);
	await runtime.createEntities([
		{ id: turn.entityId, agentId: runtime.agentId, names: ["User"] },
	]);
	await runtime.createRoomParticipants([turn.entityId], turn.roomId);
	const message = { ...turn, agentId: runtime.agentId };
	await runtime.upsertMemory(message, "messages");
	const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
	return { runtime, service, message, adapter };
}
function evaluator(
	process = vi.fn(async () => undefined),
): RegisteredEvaluator {
	return {
		name: "memory",
		description: "test",
		background: true,
		incremental: true,
		schema: {
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		},
		shouldRun: async () => true,
		prepare: async () => ({ candidate: "original" }),
		prompt: ({ prepared }) => JSON.stringify(prepared),
		processors: [{ process }],
	};
}
async function job(
	runtime: AgentRuntime,
): Promise<Task & { id: NonNullable<Task["id"]> }> {
	const rows = await runtime.getTasksByName("POST_TURN_MEMORY");
	expect(rows).toHaveLength(1);
	if (!rows[0].id) throw new Error("Missing persisted task identity");
	return { ...rows[0], id: rows[0].id };
}
async function execute(runtime: AgentRuntime, task: Task) {
	const worker = runtime.getTaskWorker("POST_TURN_MEMORY");
	if (!worker) throw new Error("Memory worker not registered");
	return worker.execute(runtime, {}, task);
}

describe("durable background memory", () => {
	it("enqueues once, admits another foreground turn during inference, then commits under room ownership", async () => {
		const { runtime, service, message } = await setup();
		const started = deferred<void>();
		const output = deferred<string>();
		const processor = vi.fn(async () => {
			expect(runtime.roomHandlerQueue.currentLease(turn.roomId)).toBeDefined();
			return undefined;
		});
		runtime.registerEvaluator(evaluator(processor));
		runtime.useModel = vi.fn(async () => {
			expect(
				runtime.roomHandlerQueue.currentLease(turn.roomId),
			).toBeUndefined();
			started.resolve();
			return output.promise;
		}) as AgentRuntime["useModel"];
		await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
			await service.enqueue(message, state, { phase: "post_turn" });
			await service.enqueue(message, state, { phase: "post_turn" });
			expect(runtime.useModel).not.toHaveBeenCalled();
		});
		const task = await job(runtime);
		const running = execute(runtime, task);
		await started.promise;
		let admitted = false;
		await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
			admitted = true;
		});
		expect(admitted).toBe(true);
		expect(processor).not.toHaveBeenCalled();
		output.resolve('{"memory":{"ok":true}}');
		await running;
		expect(processor).toHaveBeenCalledTimes(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it("reloads the durable job after service recreation without saving private provider state", async () => {
		const { runtime, service, message } = await setup();
		const processor = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(processor));
		await service.enqueue(
			message,
			{
				...state,
				text: "PRIVATE_PROVIDER_SENTINEL",
				values: { private: "SECRET_SENTINEL" },
				data: {
					actionResults: [
						{
							success: true,
							text: "Authorized read receipt",
							data: { apiKey: "PRIVATE_RECEIPT_SECRET_SENTINEL", count: 4 },
						},
					],
				},
			},
			{ phase: "post_turn" },
		);
		const task = await job(runtime);
		expect(JSON.stringify(task)).not.toContain("SENTINEL");
		await EvaluatorService.start(runtime);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await execute(runtime, task);
		expect(processor).toHaveBeenCalledTimes(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it.each(["source", "candidate"])(
		"retains the job and rejects a changed %s before any effect",
		async (changed) => {
			const { runtime, service, message } = await setup();
			const started = deferred<void>();
			const output = deferred<string>();
			const processor = vi.fn(async () => undefined);
			const item = evaluator(processor);
			let candidate = "original";
			item.prepare = async () => ({ candidate });
			runtime.registerEvaluator(item);
			runtime.useModel = vi.fn(async () => {
				started.resolve();
				return output.promise;
			}) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			const running = execute(runtime, task);
			await started.promise;
			await runtime.roomHandlerQueue.withLease(turn.roomId, async () => {
				if (changed === "source")
					await runtime.updateMemory({
						id: turn.id as NonNullable<Memory["id"]>,
						content: { text: "I live in Paris." },
					});
				else candidate = "new";
			});
			output.resolve('{"memory":{"ok":true}}');
			await expect(running).rejects.toBeInstanceOf(Error);
			expect(processor).not.toHaveBeenCalled();
			expect(await runtime.getTask(task.id)).not.toBeNull();
		},
	);

	it("replays durable staged output after a processor failure without another model call", async () => {
		const { runtime, service, message } = await setup();
		let fail = true;
		const processor = vi.fn(async () => {
			if (fail) throw new Error("injected reducer failure");
			return undefined;
		});
		runtime.registerEvaluator(evaluator(processor));
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await expect(execute(runtime, task)).rejects.toBeInstanceOf(Error);
		fail = false;
		await EvaluatorService.start(runtime);
		await execute(runtime, task);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(processor).toHaveBeenCalledTimes(2);
	});

	it("replays a real fact already written before a checkpoint failure without duplicating or regenerating", async () => {
		const { runtime, service, message } = await setup();
		runtime.registerEvaluator(factMemoryEvaluator);
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				factMemory: {
					ops: [
						{
							op: "add_durable",
							claim: "lives in Berlin",
							category: "identity",
							keywords: ["berlin"],
							structured_fields: { city: "Berlin" },
							sourceMessageIds: [message.id],
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		const original = runtime.setCache.bind(runtime);
		let fail = true;
		vi.spyOn(runtime, "setCache").mockImplementation(async (key, value) => {
			if (
				fail &&
				key.startsWith("evaluator-progress:") &&
				value &&
				typeof value === "object" &&
				!Object.hasOwn(value, "pending")
			) {
				fail = false;
				return false;
			}
			return original(key, value);
		});
		await expect(execute(runtime, task)).rejects.toBeInstanceOf(Error);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: turn.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		await EvaluatorService.start(runtime);
		await execute(runtime, task);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: turn.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it("does not run a second memory worker or cross an agent ownership boundary", async () => {
		const { runtime, service, message } = await setup();
		const started = deferred<void>();
		const output = deferred<string>();
		runtime.registerEvaluator(evaluator());
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return output.promise;
		}) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		await expect(
			execute(runtime, { ...task, agentId: turn.entityId }),
		).rejects.toMatchObject({ code: "EVALUATOR_JOB_INVALID_SCOPE" });
		const running = execute(runtime, task);
		await started.promise;
		expect(await execute(runtime, task)).toEqual({ preserveTask: true });
		output.resolve('{"memory":{"ok":true}}');
		await running;
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});
});
