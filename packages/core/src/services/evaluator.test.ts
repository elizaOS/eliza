/**
 * Exercises `EvaluatorService.run`: active evaluator sections merge into one
 * structured model call in priority order, invalid sections and processor
 * failures stay isolated, and the schema -> json_object -> plain-JSON fallback
 * ladder (with schema-skip arming) degrades gracefully. Runs against a real
 * AgentRuntime + InMemoryDatabaseAdapter with a stubbed useModel.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import {
	type Character,
	type Evaluator,
	type Memory,
	ModelType,
} from "../types";
import { EVALUATOR_PROMPT_MAX_CHARS, EvaluatorService } from "./evaluator";

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

	it("isolates invalid sections and processor failures", async () => {
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

		runtime.useModel = vi.fn(async () => ({
			invalid: { ok: true },
			throws: { ok: true },
			ok: { ok: true },
		})) as AgentRuntime["useModel"];

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
	});

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
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				evaluator: "circular",
				rawSection: expect.any(String),
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

	it("fails fast without any model call when the merged prompt exceeds the size cap (#15087)", async () => {
		const runtime = makeRuntime();

		runtime.registerEvaluator({
			name: "small",
			description: "well-behaved section",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "Extract small.",
			parse: (output) => output as never,
			processors: [
				{ name: "storeSmall", process: async () => ({ success: true }) },
			],
		});
		runtime.registerEvaluator({
			name: "runaway",
			description: "section with an unbounded context block",
			schema: schema(),
			shouldRun: async () => true,
			prompt: () => "x".repeat(EVALUATOR_PROMPT_MAX_CHARS + 1),
			parse: (output) => output as never,
			processors: [
				{ name: "storeRunaway", process: async () => ({ success: true }) },
			],
		});

		const useModel = vi.fn();
		runtime.useModel = useModel as AgentRuntime["useModel"];

		const result = await new EvaluatorService(runtime).run(makeMessage());

		// The oversized prompt is guaranteed to fail on the TEXT_SMALL tier —
		// the guard must spend zero model round-trips (the pre-guard behavior
		// burned three: schema, json_object, plain).
		expect(useModel).not.toHaveBeenCalled();
		expect(result.skipped).toBe(false);
		expect(result.processedEvaluators).toEqual([]);
		expect(result.results).toEqual([]);
		expect(result.errors).toEqual([
			{
				evaluatorName: "post_turn",
				error: expect.stringContaining("exceeds") as unknown as string,
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
});
