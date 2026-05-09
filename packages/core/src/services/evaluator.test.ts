import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import {
	type Character,
	type Evaluator,
	type Memory,
	ModelType,
} from "../types";
import { EvaluatorService } from "./evaluator";

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
	(
		runtime as unknown as {
			composeState: AgentRuntime["composeState"];
		}
	).composeState = vi.fn(async (_message, providerNames) => ({
		values: { providerNames },
		data: {
			providers: Object.fromEntries(
				(providerNames ?? []).map((name) => [name, { name }]),
			),
		},
		text: `providers:${(providerNames ?? []).join(",")}`,
	}));
	(
		runtime as unknown as {
			emitEvent: AgentRuntime["emitEvent"];
		}
	).emitEvent = vi.fn(async () => {});
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
			expect(modelType).toBe(ModelType.OBJECT_LARGE);
			expect(params.schema.properties).toHaveProperty("first");
			expect(params.schema.properties).toHaveProperty("second");
			expect(params.prompt).toContain("### first");
			expect(params.prompt).toContain("### second");
			return {
				first: { ok: true },
				second: { ok: true },
			};
		});
		(
			runtime as unknown as {
				useModel: AgentRuntime["useModel"];
			}
		).useModel = useModel as AgentRuntime["useModel"];

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

		(
			runtime as unknown as {
				useModel: AgentRuntime["useModel"];
			}
		).useModel = vi.fn(async () => ({
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
});
