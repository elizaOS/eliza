/**
 * Exercises `EvaluatorService.run`: active evaluator sections merge into one
 * structured model call in priority order, invalid sections and processor
 * failures stay isolated, and the schema -> json_object -> plain-JSON fallback
 * ladder (with schema-skip arming) degrades gracefully. Runs against a real
 * AgentRuntime + InMemoryDatabaseAdapter with a stubbed useModel.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { factMemoryEvaluator } from "../features/advanced-capabilities/evaluators/reflection-items";
import { AgentRuntime } from "../runtime";
import {
	type Character,
	type Evaluator,
	type GenerateTextResult,
	type Memory,
	ModelType,
} from "../types";
import { ChannelType } from "../types/primitives";
import { EvaluatorService, runPostTurnEvaluators } from "./evaluator";
import { getRoomTranscript } from "./evaluator-transcript";

const LARGE_PROMPT_SECTION_CHARS = 130_000;

function makeRuntime(): AgentRuntime {
	const runtime = new AgentRuntime({
		character: {
			name: "EvaluatorTestAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
	runtime.evaluators.length = 0;
	runtime.composeState = vi.fn(async (_message, providerNames) => ({
		values: { providerNames },
		data: {
			providers: Object.fromEntries(
				(providerNames ?? []).map((name) => [name, { name }]),
			),
		},
		text: `providers:${(providerNames ?? []).join(",")}`,
	}));
	runtime.emitEvent = vi.fn(async () => {});
	return runtime;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		entityId: "00000000-0000-0000-0000-000000000002" as Memory["entityId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello", source: "test" },
	} as Memory;
}

function schema() {
	return {
		type: "object",
		properties: {
			ok: { type: "boolean" },
		},
		required: ["ok"],
	};
}

describe("EvaluatorService", () => {
	it.each(["object", "JSON text", "native result"])(
		"applies fact processors from %s model output",
		async (shape) => {
			const runtime = makeRuntime();
			const message = makeMessage();
			const claim =
				"The packing list is an orange notebook and a charger, with no water.";
			const output = {
				factMemory: {
					ops: [{ op: "add_current", claim, category: "working_on" }],
				},
			};
			const raw =
				shape === "object"
					? output
					: shape === "JSON text"
						? JSON.stringify(output)
						: ({
								text: JSON.stringify(output),
								toolCalls: [],
								finishReason: "stop",
								usage: {
									promptTokens: 10,
									completionTokens: 10,
									totalTokens: 20,
								},
								providerMetadata: { provider: "cerebras" },
							} satisfies GenerateTextResult);
			runtime.registerEvaluator(factMemoryEvaluator);
			runtime.useModel = vi.fn(async () => raw) as AgentRuntime["useModel"];

			const result = await new EvaluatorService(runtime).run(message);

			expect(result.processedEvaluators).toEqual(["factMemory"]);
			expect(result.errors).toEqual([]);
			expect(result.results[0]).toMatchObject({
				success: true,
				data: { added: 1 },
			});
			const facts = await runtime.getMemories({
				tableName: "facts",
				roomId: message.roomId,
				unique: false,
			});
			expect(facts).toHaveLength(1);
			expect(facts[0]).toMatchObject({
				entityId: message.entityId,
				roomId: message.roomId,
				content: { text: claim },
				metadata: { kind: "current" },
			});
		},
	);

	it("preserves a direct evaluator section named text", async () => {
		const runtime = makeRuntime();
		const process = vi.fn(async () => ({ success: true }));
		runtime.registerEvaluator({
			name: "text",
			description: "Text-valued evaluator section",
			schema: { type: "string" },
			shouldRun: async () => true,
			prompt: () => "Return a text section.",
			processors: [{ name: "storeText", process }],
		});
		runtime.useModel = vi.fn(async () => ({
			text: "A direct section",
		})) as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(result.processedEvaluators).toEqual(["text"]);
		expect(result.errors).toEqual([]);
		expect(process).toHaveBeenCalledWith(
			expect.objectContaining({ output: "A direct section" }),
		);
	});

	it.each(["not JSON", "[]", "null", "true", ""])(
		"rejects invalid native result text %j without applying fact processors",
		async (text) => {
			const runtime = makeRuntime();
			const message = makeMessage();
			runtime.registerEvaluator(factMemoryEvaluator);
			runtime.useModel = vi.fn(async () => ({
				text,
				toolCalls: [],
				finishReason: "stop",
			})) as AgentRuntime["useModel"];

			const result = await new EvaluatorService(runtime).run(message);

			expect(result.processedEvaluators).toEqual([]);
			expect(result.results).toEqual([]);
			expect(result.errors).toEqual([
				{
					evaluatorName: "post_turn",
					error: "Evaluator model returned non-object output",
				},
			]);
			expect(
				await runtime.getMemories({
					tableName: "facts",
					roomId: message.roomId,
					unique: false,
				}),
			).toEqual([]);
		},
	);

	it("shares transcript reads within a runtime but never across runtimes", async () => {
		const first = makeRuntime();
		const second = makeRuntime();
		const message = makeMessage();
		const firstHistory = [
			{ ...message, content: { text: "First agent context" } },
		];
		const secondHistory = [
			{ ...message, content: { text: "Second agent context" } },
		];
		vi.spyOn(first, "getMemories").mockResolvedValue(firstHistory);
		vi.spyOn(second, "getMemories").mockResolvedValue(secondHistory);
		const firstRead = getRoomTranscript(first, message);
		expect(getRoomTranscript(first, message)).toBe(firstRead);
		expect(await firstRead).toEqual(firstHistory);
		expect(await getRoomTranscript(second, message)).toEqual(secondHistory);
		expect(first.getMemories).toHaveBeenCalledTimes(1);
		expect(second.getMemories).toHaveBeenCalledTimes(1);
	});

	it("retries a failed transcript read instead of caching an empty conversation", async () => {
		const runtime = makeRuntime();
		const message = makeMessage();
		vi.spyOn(runtime, "getMemories")
			.mockRejectedValueOnce(new Error("storage unavailable"))
			.mockResolvedValue([message]);
		await expect(getRoomTranscript(runtime, message)).rejects.toThrow(
			"storage unavailable",
		);
		await expect(getRoomTranscript(runtime, message)).resolves.toEqual([
			message,
		]);
		expect(runtime.getMemories).toHaveBeenCalledTimes(2);
	});

	it.each([ChannelType.VOICE_DM, ChannelType.VOICE_GROUP])(
		"does not serialize %s turns behind optional post-turn reflection",
		async (channelType) => {
			const runtime = makeRuntime();
			const getServiceLoadPromise = vi.spyOn(runtime, "getServiceLoadPromise");
			const message = makeMessage();
			message.content.channelType = channelType;

			await expect(runPostTurnEvaluators(runtime, message)).resolves.toBeNull();
			expect(getServiceLoadPromise).not.toHaveBeenCalled();
		},
	);

	it("drops the RECENT_MESSAGES provider block from the provider context once the shared transcript is rendered", async () => {
		// Live 2026-09-06: the composed state's "# Conversation Messages" block
		// was the same room history the shared context already carried.
		const runtime = makeRuntime();
		runtime.getMemories = vi.fn(async () => [
			{
				id: "00000000-0000-0000-0000-000000000011" as Memory["id"],
				entityId: "00000000-0000-0000-0000-000000000002" as Memory["entityId"],
				roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
				content: { text: "I moved to Lisbon last week", source: "test" },
			} as Memory,
		]) as AgentRuntime["getMemories"];
		runtime.registerEvaluator({
			name: "alpha",
			description: "alpha evaluator",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "alpha section",
			parse: (output) => output as never,
		});
		let prompt = "";
		runtime.useModel = vi.fn(async (_modelType, params) => {
			prompt = String(params.messages?.[0]?.content ?? "");
			return { alpha: { ok: true } };
		}) as AgentRuntime["useModel"];

		await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: {
				providerOrder: ["FACTS", "RECENT_MESSAGES"],
				providers: {
					FACTS: { text: "FACTS-BLOCK" },
					RECENT_MESSAGES: {
						text: "# Conversation Messages\nROOM-HISTORY-COPY",
					},
				},
			},
			text: "FACTS-BLOCK\n\n# Conversation Messages\nROOM-HISTORY-COPY",
		});

		expect(prompt).toContain("Room transcript");
		expect(prompt).toContain("I moved to Lisbon last week");
		expect(prompt).toContain("FACTS-BLOCK");
		expect(prompt).not.toContain("ROOM-HISTORY-COPY");
		expect(prompt).toContain('(room transcript: see "Room transcript" above)');
	});

	it("renders the room transcript once in the shared context for every section", async () => {
		// Live 2026-09-05: five sections each embedded the whole room history.
		const runtime = makeRuntime();
		const transcript: Memory[] = [
			{
				id: "00000000-0000-0000-0000-000000000011" as Memory["id"],
				entityId: "00000000-0000-0000-0000-000000000002" as Memory["entityId"],
				roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
				content: { text: "I moved to Lisbon last week", source: "test" },
			} as Memory,
			{
				id: "00000000-0000-0000-0000-000000000012" as Memory["id"],
				entityId: "00000000-0000-0000-0000-000000000009" as Memory["entityId"],
				roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
				content: { text: "Congrats on the move!", source: "test" },
			} as Memory,
		];
		runtime.getMemories = vi.fn(
			async () => transcript,
		) as AgentRuntime["getMemories"];
		const sectionFor = (name: string): Evaluator => ({
			name,
			description: `${name} evaluator`,
			providers: ["CONVERSATION_PROXIMITY"],
			schema: schema(),
			shouldRun: async () => true,
			prompt: ({ shared }) =>
				shared?.roomTranscriptRendered
					? `${name}: see shared transcript`
					: `${name}: OWN COPY`,
			parse: (output) => output as never,
		});
		runtime.registerEvaluator(sectionFor("alpha"));
		runtime.registerEvaluator(sectionFor("beta"));
		let prompt = "";
		runtime.useModel = vi.fn(async (_modelType, params) => {
			prompt = String(params.messages?.[0]?.content ?? "");
			return { alpha: { ok: true }, beta: { ok: true } };
		}) as AgentRuntime["useModel"];

		await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: {},
			text: "STAGE1-PROVIDER-BLOB",
		});

		expect(prompt.split("I moved to Lisbon last week")).toHaveLength(2);
		expect(prompt).toContain("Room transcript");
		expect(prompt).toContain("alpha: see shared transcript");
		expect(prompt).toContain("beta: see shared transcript");
		expect(prompt).not.toContain("OWN COPY");
		expect(prompt).toContain("STAGE1-PROVIDER-BLOB");
		expect(runtime.getMemories).toHaveBeenCalledTimes(1);
	});

	it("merges active evaluator sections into one structured model call", async () => {
		const runtime = makeRuntime();
		const processed: string[] = [];
		const preparedProviderNames: unknown[] = [];

		const first: Evaluator = {
			name: "first",
			description: "first evaluator",
			priority: 20,
			providers: ["RECENT_MESSAGES", "CONVERSATION_PROXIMITY"],
			schema: schema(),
			shouldRun: async () => true,
			prepare: async ({ state }) => {
				preparedProviderNames.push(state.values.providerNames);
				return { prepared: true };
			},
			prompt: () => "Extract first.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeFirst",
					process: async () => {
						processed.push("first");
						return { success: true };
					},
				},
			],
		};

		const second: Evaluator = {
			name: "second",
			description: "second evaluator",
			priority: 10,
			providers: ["RECENT_MESSAGES"],
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract second.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeSecond",
					process: async () => {
						processed.push("second");
						return { success: true };
					},
				},
			],
		};

		runtime.registerEvaluator(first);
		runtime.registerEvaluator(second);

		const useModel = vi.fn(async (modelType, params) => {
			expect(modelType).toBe(ModelType.TEXT_SMALL);
			expect(params.responseSchema.properties).toHaveProperty("first");
			expect(params.responseSchema.properties).toHaveProperty("second");
			expect(params.responseFormat).toEqual({ type: "json_object" });
			expect(params.messages?.[0]?.content).toContain("### first");
			expect(params.messages?.[0]?.content).toContain("### second");
			return {
				first: { ok: true },
				second: { ok: true },
			};
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: {},
			text: "",
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(runtime.composeState).toHaveBeenCalledWith(
			expect.anything(),
			["RECENT_MESSAGES", "CONVERSATION_PROXIMITY"],
			true,
			true,
		);
		expect(preparedProviderNames).toEqual([
			["RECENT_MESSAGES", "CONVERSATION_PROXIMITY"],
		]);
		expect(processed).toEqual(["second", "first"]);
		expect(result.processedEvaluators).toEqual(["second", "first"]);
		expect(result.errors).toEqual([]);
	});

	it.each(["object", "native result"])(
		"isolates invalid sections and processor failures from %s",
		async (shape) => {
			const runtime = makeRuntime();
			const processed: string[] = [];

			runtime.registerEvaluator({
				name: "invalid",
				description: "invalid section",
				priority: 10,
				schema: schema(),
				shouldRun: async () => true,
				prompt: () => "Extract invalid.",
				parse: () => null,
				processors: [
					{
						process: async () => {
							processed.push("invalid");
						},
					},
				],
			});

			runtime.registerEvaluator({
				name: "throws",
				description: "throws section",
				priority: 20,
				schema: schema(),
				shouldRun: async () => true,
				prompt: () => "Extract throws.",
				parse: (output) => output as never,
				processors: [
					{
						name: "throwingProcessor",
						process: async () => {
							throw new Error("processor failed");
						},
					},
				],
			});

			runtime.registerEvaluator({
				name: "ok",
				description: "ok section",
				priority: 30,
				schema: schema(),
				shouldRun: async () => true,
				prompt: () => "Extract ok.",
				parse: (output) => output as never,
				processors: [
					{
						process: async () => {
							processed.push("ok");
							return { success: true };
						},
					},
				],
			});

			const output = {
				invalid: { ok: true },
				throws: { ok: true },
				ok: { ok: true },
			};
			runtime.useModel = vi.fn(async () =>
				shape === "object"
					? output
					: {
							text: JSON.stringify(output),
							toolCalls: [],
							finishReason: "stop",
						},
			) as AgentRuntime["useModel"];

			const result = await new EvaluatorService(runtime).run(makeMessage());

			expect(processed).toEqual(["ok"]);
			expect(result.processedEvaluators).toEqual(["throws", "ok"]);
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						evaluatorName: "invalid",
						error: "Evaluator output section did not validate",
					}),
					expect.objectContaining({
						evaluatorName: "throws",
						processorName: "throwingProcessor",
						error: "processor failed",
					}),
				]),
			);
		},
	);

	it("logs an unserializable invalid section without aborting the run", async () => {
		const runtime = makeRuntime();
		const warnSpy = vi.spyOn(runtime.logger, "warn");
		const processed: string[] = [];

		runtime.registerEvaluator({
			name: "circular",
			description: "circular section",
			priority: 20,
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract circular.",
			parse: () => null,
			processors: [
				{
					process: async () => {
						processed.push("circular");
					},
				},
			],
		});

		runtime.registerEvaluator({
			name: "ok",
			description: "ok section",
			priority: 10,
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract ok.",
			parse: (output) => output as never,
			processors: [
				{
					process: async () => {
						processed.push("ok");
						return { success: true };
					},
				},
			],
		});

		const circularSection: Record<string, unknown> = { big: 1n };
		circularSection.self = circularSection;
		runtime.useModel = vi.fn(async () => ({
			circular: circularSection,
			ok: { ok: true },
		})) as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		// JSON.stringify throws on this section; the log must not turn one
		// evaluator's parse failure into an abort of the whole run.
		expect(processed).toEqual(["ok"]);
		expect(result.processedEvaluators).toEqual(["ok"]);
		expect(result.errors).toEqual([
			expect.objectContaining({
				evaluatorName: "circular",
				error: "Evaluator output section did not validate",
			}),
		]);
		// The log payload carries a bounded PREVIEW of the section, not the
		// section itself — a diagnostic surface, never model-facing context, so
		// CLAUDE.md's prompt-integrity rule permits the bound and requires the
		// field to name itself a preview.
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				evaluator: "circular",
				rawSectionPreview: expect.any(String),
			}),
			"Evaluator output section did not validate",
		);
	});

	it("retries without responseSchema when the provider rejects structured schemas", async () => {
		const runtime = makeRuntime();
		const processed: string[] = [];

		runtime.registerEvaluator({
			name: "ok",
			description: "ok section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract ok.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeOk",
					process: async () => {
						processed.push("ok");
						return { success: true };
					},
				},
			],
		});

		const useModel = vi
			.fn()
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce({ ok: { ok: true } });
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(useModel.mock.calls[0]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[1]?.[1]).not.toHaveProperty("responseSchema");
		expect(useModel.mock.calls[1]?.[1]?.responseFormat).toEqual({
			type: "json_object",
		});
		expect(processed).toEqual(["ok"]);
		expect(result.errors).toEqual([]);
	});

	it("falls back to a plain JSON prompt when JSON-object mode is also rejected", async () => {
		const runtime = makeRuntime();
		const processed: string[] = [];

		runtime.registerEvaluator({
			name: "ok",
			description: "ok section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract ok.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeOk",
					process: async () => {
						processed.push("ok");
						return { success: true };
					},
				},
			],
		});

		const useModel = vi
			.fn()
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce('{"ok":{"ok":true}}');
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(useModel.mock.calls[0]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[1]?.[1]).toHaveProperty("responseFormat");
		expect(useModel.mock.calls[2]?.[1]).not.toHaveProperty("responseSchema");
		expect(useModel.mock.calls[2]?.[1]).not.toHaveProperty("responseFormat");
		expect(processed).toEqual(["ok"]);
		expect(result.errors).toEqual([]);
	});

	it("contains provider generation failures as post-turn evaluator errors", async () => {
		const runtime = makeRuntime();

		runtime.registerEvaluator({
			name: "ok",
			description: "ok section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract ok.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeOk",
					process: async () => ({ success: true }),
				},
			],
		});

		const useModel = vi
			.fn()
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockRejectedValueOnce(new Error("Bad Request"));
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.processedEvaluators).toEqual([]);
		expect(result.results).toEqual([]);
		expect(result.errors).toEqual([
			{
				evaluatorName: "post_turn",
				error: "Bad Request",
			},
		]);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				evaluatorName: "post_turn",
				completed: false,
			}),
		);
	});

	const registerOkEvaluator = (runtime: AgentRuntime): void => {
		runtime.registerEvaluator({
			name: "ok",
			description: "ok section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract ok.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeOk",
					process: async () => ({ success: true }),
				},
			],
		});
	};

	it("arms the schema skip after repeated generic rejections", async () => {
		const runtime = makeRuntime();
		registerOkEvaluator(runtime);

		const useModel = vi
			.fn()
			// Turn 1: generic 400 (streak 1, not yet armed) → json_object succeeds.
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce({ ok: { ok: true } })
			// Turn 2: generic 400 again (streak 2 → arm) → json_object succeeds.
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce({ ok: { ok: true } })
			// Turn 3: armed → straight to json_object, no schema attempt.
			.mockResolvedValueOnce({ ok: { ok: true } });
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const service = new EvaluatorService(runtime);
		await service.run(makeMessage());
		await service.run(makeMessage());
		await service.run(makeMessage());

		// Turns 1 & 2 each attempt the schema (2 calls); turn 3 skips it (1 call).
		expect(useModel).toHaveBeenCalledTimes(5);
		expect(useModel.mock.calls[0]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[2]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[4]?.[1]).not.toHaveProperty("responseSchema");
		expect(useModel.mock.calls[4]?.[1]?.responseFormat).toEqual({
			type: "json_object",
		});
	});

	it("arms the schema skip immediately on an explicit schema rejection", async () => {
		const runtime = makeRuntime();
		registerOkEvaluator(runtime);

		const useModel = vi
			.fn()
			// Turn 1: provider names the schema as the problem → arm immediately.
			.mockRejectedValueOnce(
				new Error("json_schema response_format is unsupported"),
			)
			.mockResolvedValueOnce({ ok: { ok: true } })
			// Turn 2: armed → straight to json_object.
			.mockResolvedValueOnce({ ok: { ok: true } });
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const service = new EvaluatorService(runtime);
		await service.run(makeMessage());
		await service.run(makeMessage());

		// Schema-specific rejection arms after a single turn (no streak needed).
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(useModel.mock.calls[0]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[2]?.[1]).not.toHaveProperty("responseSchema");
	});

	it("does not arm on a one-off generic rejection that later succeeds", async () => {
		const runtime = makeRuntime();
		registerOkEvaluator(runtime);

		const useModel = vi
			.fn()
			// Turn 1: transient generic 400 (streak 1) → json_object succeeds.
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce({ ok: { ok: true } })
			// Turn 2: schema SUCCEEDS → streak resets.
			.mockResolvedValueOnce({ ok: { ok: true } })
			// Turn 3: another lone generic 400 (streak back to 1, still not armed).
			.mockRejectedValueOnce(new Error("Bad Request"))
			.mockResolvedValueOnce({ ok: { ok: true } });
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const service = new EvaluatorService(runtime);
		await service.run(makeMessage());
		await service.run(makeMessage());
		await service.run(makeMessage());

		// The transient blip never sticks: turns 2 and 3 still attempt the schema.
		expect(useModel).toHaveBeenCalledTimes(5);
		expect(useModel.mock.calls[2]?.[1]).toHaveProperty("responseSchema");
		expect(useModel.mock.calls[3]?.[1]).toHaveProperty("responseSchema");
	});

	it("renders complete action results without dropping the data payload", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator({
			name: "gamma",
			description: "gamma section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract gamma.",
			parse: (output) => output as never,
			processors: [
				{ name: "storeGamma", process: async () => ({ success: true }) },
			],
		});

		const hugeDataMarker = "FULL_HIT_TEXT_ONLY_IN_DATA";
		const actionResult = {
			success: true,
			text: "Showing all 7 match(es) found in the scanned window.",
			data: {
				actionName: "MEMORY",
				op: "search",
				memories: Array.from({ length: 17 }, (_, i) => ({
					id: `id-${i}`,
					text: `${hugeDataMarker} ${"detail ".repeat(300)}`,
				})),
			},
			promptData: {
				actionName: "MEMORY",
				op: "search",
				matchedInWindow: 7,
			},
		};

		const useModel = vi.fn(async (_modelType, params) => {
			const prompt = String(params.messages?.[0]?.content ?? "");
			// Every model-facing carrier remains complete.
			expect(prompt).toContain("MEMORY - succeeded");
			expect(prompt).toContain("Showing all 7 match(es)");
			expect(prompt).toContain('"matchedInWindow":7');
			expect(prompt).toContain(hugeDataMarker);
			return { gamma: { ok: true } };
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: { actionResults: [actionResult] },
			text: "",
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(result.errors).toEqual([]);
	});

	it("keeps supported data-only action fields visible to the evaluator model", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator({
			name: "data-only",
			description: "data-only section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Inspect the action result.",
			parse: (output) => output as never,
			processors: [
				{ name: "storeDataOnly", process: async () => ({ success: true }) },
			],
		});
		const useModel = vi.fn(async (_modelType, params) => {
			const prompt = String(params.messages?.[0]?.content ?? "");
			expect(prompt).toContain("UNINSTALL_SKILL - succeeded");
			expect(prompt).toContain('"awaitingUserInput":true');
			expect(prompt).toContain('"slug":"demo-skill"');
			return { "data-only": { ok: true } };
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const actionResult = {
			success: true,
			data: {
				actionName: "UNINSTALL_SKILL",
				awaitingUserInput: true,
				slug: "demo-skill",
			},
		};
		const state = {
			values: {},
			data: { actionResults: [actionResult] },
			text: "",
		};
		await new EvaluatorService(runtime).run(makeMessage(), state);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(state.data.actionResults[0]?.data).toEqual(actionResult.data);
	});

	it("keeps oversized action JSON complete", async () => {
		const runtime = makeRuntime();
		runtime.registerEvaluator({
			name: "bounded-data",
			description: "bounded-data section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Inspect the action result.",
			parse: (output) => output as never,
			processors: [
				{ name: "storeBoundedData", process: async () => ({ success: true }) },
			],
		});
		const oversizedMarker = "OVERSIZED_PRIVATE_DETAIL".repeat(2_000);
		const useModel = vi.fn(async (_modelType, params) => {
			const prompt = String(params.messages?.[0]?.content ?? "");
			expect(prompt).toContain('"actionName":"UNINSTALL_SKILL"');
			expect(prompt).toContain('"awaitingUserInput":true');
			expect(prompt).toContain('"slug":"demo-skill"');
			expect(prompt).not.toContain('"__truncated":true');
			expect(prompt).toContain(oversizedMarker);
			return { "bounded-data": { ok: true } };
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: {
				actionResults: [
					{
						success: true,
						data: {
							actionName: "UNINSTALL_SKILL",
							awaitingUserInput: true,
							slug: "demo-skill",
							details: oversizedMarker,
						},
					},
				],
			},
			text: "",
		});

		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("keeps oversized shared provider context complete", async () => {
		const runtime = makeRuntime();
		const processed: string[] = [];

		runtime.registerEvaluator({
			name: "alpha",
			description: "alpha section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract alpha.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeAlpha",
					process: async () => {
						processed.push("alpha");
						return { success: true };
					},
				},
			],
		});
		runtime.registerEvaluator({
			name: "beta",
			description: "beta section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract beta.",
			parse: (output) => output as never,
			processors: [
				{
					name: "storeBeta",
					process: async () => {
						processed.push("beta");
						return { success: true };
					},
				},
			],
		});

		const providerTail = "SHARED_PROVIDER_TAIL";
		const oversizedProviderContext = `SHARED_PROVIDER_PREFIX${"x".repeat(
			LARGE_PROMPT_SECTION_CHARS,
		)}${providerTail}`;
		const useModel = vi.fn(async (_modelType, params) => {
			const prompt = String(params.messages?.[0]?.content ?? "");
			expect(prompt.length).toBeGreaterThan(LARGE_PROMPT_SECTION_CHARS);
			expect(prompt).toContain(providerTail);
			expect(prompt).toContain("SHARED_PROVIDER_PREFIX");
			expect(prompt).toContain("### alpha");
			expect(prompt).toContain('Put result under "alpha".');
			expect(prompt).toContain("### beta");
			expect(prompt).toContain('Put result under "beta".');
			return {
				alpha: { ok: true },
				beta: { ok: true },
			};
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage(), {
			values: {},
			data: {},
			text: oversizedProviderContext,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(processed).toEqual(["alpha", "beta"]);
		expect(result.errors).toEqual([]);
	});

	it("keeps oversized evaluator sections complete", async () => {
		const runtime = makeRuntime();
		const processed: string[] = [];
		const evaluatorTail = "RUNAWAY_EVALUATOR_TAIL";

		for (const name of ["small", "runaway", "later"]) {
			runtime.registerEvaluator({
				name,
				description: `${name} section`,
				schema: schema(),
				shouldRun: async () => true,
				prompt: () =>
					name === "runaway"
						? `RUNAWAY_EVALUATOR_PREFIX${"x".repeat(
								LARGE_PROMPT_SECTION_CHARS,
							)}${evaluatorTail}`
						: `Extract ${name}.`,
				parse: (output) => output as never,
				processors: [
					{
						name: `store-${name}`,
						process: async () => {
							processed.push(name);
							return { success: true };
						},
					},
				],
			});
		}

		const useModel = vi.fn(async (_modelType, params) => {
			const prompt = String(params.messages?.[0]?.content ?? "");
			expect(prompt.length).toBeGreaterThan(LARGE_PROMPT_SECTION_CHARS);
			expect(prompt).toContain(evaluatorTail);
			expect(prompt).toContain("RUNAWAY_EVALUATOR_PREFIX");
			for (const name of ["small", "runaway", "later"]) {
				expect(prompt).toContain(`### ${name}`);
				expect(prompt).toContain(`Put result under "${name}".`);
			}
			return {
				small: { ok: true },
				runaway: { ok: true },
				later: { ok: true },
			};
		});
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.skipped).toBe(false);
		expect(processed).toEqual(["later", "runaway", "small"]);
		expect(result.errors).toEqual([]);
	});
});
