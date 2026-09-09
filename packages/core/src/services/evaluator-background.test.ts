/** Durable handoff and room ownership through real runtime/task/cache adapters. */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import {
	factMemoryEvaluator,
	relationshipEvaluator,
} from "../features/advanced-capabilities/evaluators/reflection-items";
import { AgentRuntime } from "../runtime";
import {
	ChannelType,
	type Character,
	type Memory,
	type RegisteredEvaluator,
	type State,
	type Task,
} from "../types";
import { stringToUuid } from "../utils";
import { isActiveMemoryEvidence } from "../utils/extraction-evidence";
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
	it("supplies the complete future trigger and receipts only when their evidence page is selected", async () => {
		const { runtime, service, message } = await setup();
		const old = {
			...message,
			id: stringToUuid("earlier-own-statement"),
			createdAt: 0,
			content: {
				text: "Earlier complete owner statement with violet notebook.",
			},
		};
		await runtime.upsertMemory(old, "messages");
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		runtime.registerEvaluator(evaluator());
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(
			message,
			{
				...state,
				data: {
					actionResults: [{ success: true, text: "FUTURE_TURN_RECEIPT" }],
				},
			},
			{ phase: "post_turn" },
		);
		const task = await job(runtime);
		await execute(runtime, task);
		const params = vi.mocked(runtime.useModel).mock.calls[0][1] as {
			messages: Array<{ content: string }>;
		};
		const first = params.messages.map((row) => row.content).join("\n");
		expect(first).toContain(old.content.text);
		expect(first).not.toContain(message.content.text);
		expect(first).not.toContain("FUTURE_TURN_RECEIPT");
		expect(first).toContain("later evidence page");
		await execute(runtime, task);
		const last = vi.mocked(runtime.useModel).mock.calls[1][1] as {
			messages: Array<{ content: string }>;
		};
		expect(last.messages.map((row) => row.content).join("\n")).toContain(
			message.content.text,
		);
		expect(last.messages.map((row) => row.content).join("\n")).toContain(
			"FUTURE_TURN_RECEIPT",
		);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it("keeps diverged full pages queued when their union exceeds the shared request budget", async () => {
		const { runtime, service, message } = await setup();
		const observed: Record<string, string[]> = { lead: [], lag: [] };
		const lane = (name: string) => ({
			...evaluator(),
			name,
			processors: [
				{
					process: async ({
						options,
					}: Parameters<
						NonNullable<RegisteredEvaluator["processors"]>[number]["process"]
					>[0]) => {
						observed[name].push(
							...(options.extraction?.messages ?? []).map((row) =>
								String(row.id),
							),
						);
						return undefined;
					},
				},
			],
		});
		runtime.registerEvaluator(lane("lead"));
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({ lead: { ok: true }, lag: { ok: true } }),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const next = {
			...message,
			id: stringToUuid("bounded-union-next"),
			createdAt: 20,
			content: { text: "The complete next source, with its detail intact." },
		};
		await runtime.upsertMemory(next, "messages");
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		runtime.registerEvaluator(lane("lag"));
		await service.enqueue(next, state, { phase: "post_turn" });
		const task = await job(runtime);
		await execute(runtime, task);
		expect(await runtime.getTask(task.id)).not.toBeNull();
		for (let i = 0; i < 3 && (await runtime.getTask(task.id)); i++)
			await execute(runtime, task);
		expect(observed).toEqual({
			lead: [message.id, next.id],
			lag: [message.id, next.id],
		});
		expect(await runtime.getTask(task.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("shares exact selected ID lists between diverged lanes without losing evidence", async () => {
		const { runtime, service, message } = await setup();
		for (const name of ["leadA", "leadB"])
			runtime.registerEvaluator({ ...evaluator(), name });
		runtime.useModel = vi.fn(async () =>
			JSON.stringify({
				leadA: { ok: true },
				leadB: { ok: true },
				lag: { ok: true },
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const next = {
			...message,
			id: stringToUuid("diverged-new-message"),
			createdAt: 20,
			content: { text: "Full second message with a new detail." },
		};
		await runtime.upsertMemory(next, "messages");
		runtime.registerEvaluator({ ...evaluator(), name: "lag" });
		await service.enqueue(next, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const calls = vi.mocked(runtime.useModel).mock.calls;
		const params = calls.at(-1)?.[1] as {
			messages: Array<{ content: string }>;
		};
		const prompt = params.messages.map((row) => row.content).join("\n");
		expect(prompt).toContain(message.content.text);
		expect(prompt).toContain(next.content.text);
		expect(prompt.match(/evidence-set-1:/g)).toHaveLength(1);
		expect(
			prompt.match(/only the exact source IDs in evidence-set-1/g),
		).toHaveLength(2);
		expect(prompt).not.toContain("evidence-set-2");
		expect(
			JSON.parse(prompt.match(/evidence-set-1: (\[[\s\S]*?\])/)?.[1] ?? "null"),
		).toEqual([next.id]);
	});

	it("advances other-speaker backfill pages without personal inference, then extracts the target speaker", async () => {
		const { runtime, service, message } = await setup();
		for (let i = 0; i < 2; i++)
			await runtime.upsertMemory(
				{
					...message,
					id: stringToUuid(`other-speaker-page:${i}`),
					entityId: runtime.agentId,
					createdAt: i,
					content: {
						text: `Complete historical agent record ${i} ${"context ".repeat(20)}`,
					},
				},
				"messages",
			);
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
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
		await execute(runtime, task);
		await execute(runtime, task);
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(await runtime.getTask(task.id)).not.toBeNull();
		await execute(runtime, task);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(
			await runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				unique: false,
			}),
		).toHaveLength(1);
		expect(await runtime.getTask(task.id)).toBeNull();
	});

	it.each([false, true])(
		"uses a deterministic resolver only when its evidence predicate permits it (%s)",
		async (resolve) => {
			const { runtime, service, message } = await setup();
			const item = evaluator();
			item.resolveOutputWhen = () => resolve;
			item.resolveOutput = vi.fn(() => ({ ok: true }));
			runtime.registerEvaluator(item);
			runtime.useModel = vi.fn(
				async () => '{"memory":{"ok":true}}',
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			expect(runtime.useModel).toHaveBeenCalledTimes(resolve ? 0 : 1);
			expect(item.resolveOutput).toHaveBeenCalledTimes(resolve ? 1 : 0);
		},
	);

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
	it("processes a lossless initial backfill over durable ordered worker invocations", async () => {
		const { runtime, service, message } = await setup();
		const earlier = Array.from({ length: 5 }, (_, i) => ({
			...message,
			id: stringToUuid(`backfill:${i}`),
			createdAt: i,
			content: { text: `Complete record ${i}\n🍊 ${"source ".repeat(15)}` },
		}));
		for (const source of earlier)
			await runtime.upsertMemory(source, "messages");
		const stored = await runtime.getMemories({
			tableName: "messages",
			roomId: message.roomId,
			unique: false,
			includeEmbedding: false,
			orderDirection: "asc",
		});
		const budget =
			Math.max(
				...stored.map(
					(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
				),
			) + 1;
		vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
			key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
		);
		const observed: Memory[] = [];
		const item = evaluator();
		item.processors = [
			{
				process: async ({ options }) => {
					observed.push(...(options.extraction?.messages ?? []));
					return undefined;
				},
			},
		];
		runtime.registerEvaluator(item);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const task = await job(runtime);
		for (let i = 0; i < stored.length; i++) await execute(runtime, task);
		expect(
			observed.map((row) => ({ id: row.id, content: row.content })),
		).toEqual(
			[...earlier, message].map((row) => ({
				id: row.id,
				content: row.content,
			})),
		);
		expect(await runtime.getTask(task.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(stored.length);
	});

	it.each([false, true])(
		"restores a full prior page before effects and rejects changed reference evidence (changed=%s)",
		async (changeReference) => {
			const { runtime, service, message } = await setup();
			const earlier = {
				...message,
				id: stringToUuid("prior-detail"),
				createdAt: 1,
				content: {
					text: "The notebook in this story is violet.\nFull reference 🍊",
				},
			};
			await runtime.upsertMemory(earlier, "messages");
			const stored = await runtime.getMemories({
				tableName: "messages",
				roomId: message.roomId,
				unique: false,
				includeEmbedding: false,
				orderDirection: "asc",
			});
			const budget =
				Math.max(
					...stored.map(
						(row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
					),
				) + 1;
			vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
				key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
			);
			const processor = vi.fn(async () => undefined);
			runtime.registerEvaluator(evaluator(processor));
			let call = 0;
			runtime.useModel = vi.fn(async (_type, params) => {
				call++;
				if (call === 2)
					return JSON.stringify({
						restoreContextBefore: message.id,
						memory: { ok: false },
					});
				if (call === 3) {
					expect(JSON.stringify(params)).toContain(
						"The notebook in this story is violet.",
					);
					expect(JSON.stringify(params)).toContain("Full reference 🍊");
					expect(processor).toHaveBeenCalledTimes(1);
					if (changeReference)
						await runtime.roomHandlerQueue.withLease(
							message.roomId,
							async () => {
								await runtime.updateMemory({
									id: earlier.id,
									content: { text: "The notebook is copper." },
								});
							},
						);
				}
				return '{"memory":{"ok":true}}';
			}) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			const task = await job(runtime);
			await execute(runtime, task);
			if (changeReference) {
				await expect(execute(runtime, task)).rejects.toMatchObject({
					code: "EVALUATOR_JOB_PENDING",
					context: {
						errors: [
							{
								evaluatorName: "memory",
								error: expect.stringContaining(
									"Staged evaluator evidence changed",
								),
							},
						],
					},
				});
				expect(processor).toHaveBeenCalledTimes(1);
			} else {
				await execute(runtime, task);
				expect(processor).toHaveBeenCalledTimes(2);
				expect(await runtime.getTask(task.id)).toBeNull();
			}
			expect(runtime.useModel).toHaveBeenCalledTimes(3);
		},
	);
	it.each(["edit", "delete"])(
		"reconciles a %s on the next authoritative scan while preserving explicit and foreign records",
		async (change) => {
			const { runtime, service, message } = await setup();
			runtime.registerEvaluator(factMemoryEvaluator);
			let city = "Berlin";
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({
					factMemory: {
						ops: city
							? [
									{
										op: "add_durable",
										claim: `lives in ${city}`,
										category: "identity",
										keywords: [city.toLowerCase()],
										structured_fields: { city },
										sourceMessageIds: [message.id],
									},
								]
							: [],
					},
				}),
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const original = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			)[0];
			const explicit: Memory = {
				...original,
				id: stringToUuid(`manual:${change}`),
				content: { text: "Owner saved record", source: "MEMORY" },
				metadata: { ...original.metadata, type: "custom", source: "MEMORY" },
			};
			const foreign: Memory = {
				...original,
				id: stringToUuid(`foreign:${change}`),
				entityId: stringToUuid("other-person"),
				content: { text: "Other person's record" },
			};
			await runtime.upsertMemory(explicit, "facts");
			await runtime.upsertMemory(foreign, "facts");
			let trigger = message;
			if (change === "edit") {
				city = "Paris";
				await runtime.updateMemory({
					id: message.id as NonNullable<Memory["id"]>,
					content: { text: "I live in Paris." },
				});
				trigger = { ...message, content: { text: "I live in Paris." } };
			} else {
				city = "";
				await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
				trigger = {
					...message,
					id: stringToUuid("after-delete"),
					createdAt: 20,
					content: { text: "Continue our conversation." },
				};
				await runtime.upsertMemory(trigger, "messages");
			}
			await service.enqueue(trigger, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const all = await runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				unique: false,
			});
			const retired = all.find((row) => row.id === original.id);
			expect(retired?.content).toEqual(original.content);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect(all.find((row) => row.id === explicit.id)).toEqual(explicit);
			expect(all.find((row) => row.id === foreign.id)).toEqual(foreign);
			const ownActive = all.filter(
				(row) =>
					row.entityId === message.entityId &&
					row.id !== explicit.id &&
					isActiveMemoryEvidence(row),
			);
			expect(ownActive.map((row) => row.content.text)).toEqual(
				change === "edit" ? ["lives in Paris"] : [],
			);
			expect(runtime.useModel).toHaveBeenCalledTimes(2);
		},
	);

	it("re-examines unchanged surviving support instead of losing a multiply-supported claim", async () => {
		const { runtime, service, message } = await setup();
		const second = {
			...message,
			id: stringToUuid("independent-support"),
			createdAt: 11,
			content: { text: "Berlin is still my home." },
		};
		await runtime.upsertMemory(second, "messages");
		runtime.registerEvaluator(factMemoryEvaluator);
		let sources = [message.id, second.id];
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
							sourceMessageIds: sources,
						},
					],
				},
			}),
		) as AgentRuntime["useModel"];
		await service.enqueue(second, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
		sources = [second.id];
		await service.enqueue(second, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		const facts = await runtime.getMemories({
			tableName: "facts",
			roomId: message.roomId,
			unique: false,
		});
		expect(facts).toHaveLength(2);
		expect(facts.filter(isActiveMemoryEvidence)).toHaveLength(1);
		expect(facts.filter(isActiveMemoryEvidence)[0].content.text).toBe(
			"lives in Berlin",
		);
	});

	it("rereads real relationship candidates after foreground changes during inference", async () => {
		const { runtime, service, message } = await setup();
		const other = stringToUuid("candidate-change-peer");
		await runtime.createEntities([
			{ id: other, agentId: runtime.agentId, names: ["Peer"] },
		]);
		await runtime.createRoomParticipants([other], message.roomId);
		runtime.registerEvaluator(relationshipEvaluator);
		const started = deferred<void>();
		const release = deferred<string>();
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return release.promise;
		}) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		const running = execute(runtime, await job(runtime));
		await started.promise;
		await runtime.roomHandlerQueue.withLease(message.roomId, () =>
			runtime.createRelationship({
				sourceEntityId: message.entityId,
				targetEntityId: other,
				tags: ["friend"],
			}),
		);
		release.resolve(JSON.stringify({ relationships: [] }));
		await expect(running).rejects.toMatchObject({
			code: "EVALUATOR_CANDIDATES_CHANGED",
		});
	});

	it.each(["update", "upsert", "delete"])(
		"automatically retires source-derived facts on %s without another conversation",
		async (operation) => {
			const { runtime, service, message } = await setup();
			runtime.services.set("evaluator", [service]);
			runtime.registerEvaluator(factMemoryEvaluator);
			let city = "Berlin";
			runtime.useModel = vi.fn(async () =>
				JSON.stringify({
					factMemory: {
						ops: [
							{
								op: "add_durable",
								claim: `lives in ${city}`,
								category: "identity",
								keywords: [city.toLowerCase()],
								structured_fields: { city },
								sourceMessageIds: [message.id],
							},
						],
					},
				}),
			) as AgentRuntime["useModel"];
			await service.enqueue(message, state, { phase: "post_turn" });
			await execute(runtime, await job(runtime));
			const oldFact = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			)[0];
			// Embedding bookkeeping does not queue a second model call.
			await runtime.updateMemory({
				id: message.id as NonNullable<Memory["id"]>,
				embedding: [1, 0, 0],
			});
			expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toHaveLength(0);
			city = "Paris";
			await runtime.roomHandlerQueue.withLease(message.roomId, async () => {
				if (operation === "delete")
					await runtime.deleteMemory(message.id as NonNullable<Memory["id"]>);
				else if (operation === "upsert")
					await runtime.upsertMemory(
						{ ...message, content: { text: "I live in Paris." } },
						"messages",
					);
				else
					await runtime.updateMemory({
						id: message.id as NonNullable<Memory["id"]>,
						content: { text: "I live in Paris." },
					});
			});
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
			const retired = await runtime.getMemoryById(
				oldFact.id as NonNullable<Memory["id"]>,
			);
			expect(retired && isActiveMemoryEvidence(retired)).toBe(false);
			expect(retired?.content).toEqual(oldFact.content);
			const task = await job(runtime);
			// Resume using a new service instance, as on restart.
			await EvaluatorService.start(runtime);
			await execute(runtime, task);
			expect(
				await runtime.getTask(task.id as NonNullable<Task["id"]>),
			).toBeNull();
			const active = (
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				})
			).filter(isActiveMemoryEvidence);
			expect(active.map((row) => row.content.text)).toEqual(
				operation === "delete" ? [] : ["lives in Paris"],
			);
			expect(runtime.useModel).toHaveBeenCalledTimes(
				operation === "delete" ? 1 : 2,
			);
		},
	);
	it("coalesces repeated source updates with the delivery job and preserves a newer wakeup during inference", async () => {
		const { runtime, service, message } = await setup();
		runtime.services.set("evaluator", [service]);
		const process = vi.fn(async () => undefined);
		runtime.registerEvaluator(evaluator(process));
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: { text: "temporary revision" },
		});
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: message.content,
		});
		expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toHaveLength(0);
		runtime.useModel = vi.fn(
			async () => '{"memory":{"ok":true}}',
		) as AgentRuntime["useModel"];
		await service.enqueue(message, state, { phase: "post_turn" });
		await execute(runtime, await job(runtime));
		process.mockClear();
		const next = {
			...message,
			id: stringToUuid("next-coalesced-turn"),
			createdAt: 20,
			content: { text: "A new follow-up." },
		};
		await runtime.upsertMemory(next, "messages");
		await service.enqueue(next, state, { phase: "post_turn" });
		const first = await job(runtime);
		const started = deferred<void>();
		const release = deferred<string>();
		runtime.useModel = vi.fn(async () => {
			started.resolve();
			return release.promise;
		}) as AgentRuntime["useModel"];
		const running = execute(runtime, first);
		await started.promise;
		// Restoring the identical source leaves the generated output valid, but the
		// task now carries a newer wakeup which the older execution cannot erase.
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: { text: "another temporary revision" },
		});
		await runtime.updateMemory({
			id: message.id as NonNullable<Memory["id"]>,
			content: message.content,
		});
		const current = await job(runtime);
		expect(current.id).toBe(first.id);
		expect(current.metadata?.reconciliationRevision).not.toBe(
			first.metadata?.reconciliationRevision,
		);
		release.resolve('{"memory":{"ok":true}}');
		await running;
		expect(await runtime.getTask(first.id)).not.toBeNull();
		await execute(runtime, await job(runtime));
		expect(await runtime.getTask(first.id)).toBeNull();
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(process).toHaveBeenCalledTimes(1);
	});
});
