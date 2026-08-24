/**
 * Exercises AgentRuntime final prepared-request budgeting with real routing,
 * pre-model hooks, failover, and provider handlers. Deterministic fake handlers
 * prove every text-generation slot dispatches complete input unchanged. Only
 * an authoritative provider failure may reject or trigger failover; token
 * estimates remain diagnostic because they are not provider tokenization.
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: { name: "FinalWireBudget", bio: "test" } as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("AgentRuntime final model-input budget", () => {
	it.each([
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_SMALL,
	])(
		"dispatches complete estimated-large %s input to its handler",
		async (modelType) => {
			const runtime = makeRuntime();
			const handler = vi.fn(async () => "complete");
			runtime.registerModel(modelType, handler, "tiny", 10, {
				contextWindowTokens: 20_000,
				displayModel: "tiny-final-wire",
			});

			await expect(
				runtime.useModel(modelType, {
					messages: [
						{ role: "user", content: `HEAD${"x".repeat(15_000)}TAIL` },
					],
				}),
			).resolves.toBe("complete");
			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler.mock.calls[0][1]).toMatchObject({
				providerOptions: {
					eliza: { modelInputBudget: { shouldReject: false } },
				},
			});
		},
	);

	it("dispatches content added by pre-model hooks unchanged", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "complete");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});
		runtime.registerPipelineHook({
			id: "grow-final-request",
			phase: "pre_model",
			handler: (_runtime, context) => {
				if (
					context.phase === "pre_model" &&
					context.params &&
					typeof context.params === "object" &&
					"prompt" in context.params
				) {
					(context.params as { prompt: string }).prompt += "y".repeat(15_000);
				}
			},
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, { prompt: "small initially" }),
		).resolves.toBe("complete");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0][1]).toMatchObject({
			prompt: `small initially${"y".repeat(15_000)}`,
		});
	});

	it("dispatches an estimated-large provider-options payload unchanged", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "complete");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "small",
				providerOptions: { custom: { blob: "x".repeat(15_000) } },
			}),
		).resolves.toBe("complete");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0][1]).toMatchObject({
			providerOptions: { custom: { blob: "x".repeat(15_000) } },
		});
	});

	it("dispatches an immutable clone without mutating caller-owned data", async () => {
		const runtime = makeRuntime();
		const callerParams = {
			prompt: "small",
			messages: [{ role: "user" as const, content: "complete" }],
			providerOptions: { custom: { mode: "exact" } },
		};
		const handler = vi.fn(async (_runtime, params: Record<string, unknown>) => {
			expect(params).not.toBe(callerParams);
			expect(params.messages).not.toBe(callerParams.messages);
			expect(params.providerOptions).not.toBe(callerParams.providerOptions);
			expect(Object.isFrozen(params)).toBe(true);
			expect(Object.isFrozen(params.messages)).toBe(true);
			expect(Object.isFrozen(params.providerOptions)).toBe(true);
			expect(() => {
				(params.providerOptions as Record<string, unknown>).late = "unmeasured";
			}).toThrow();
			return "ok";
		});
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "small", 10, {
			contextWindowTokens: 20_000,
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, callerParams),
		).resolves.toBe("ok");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(callerParams.providerOptions).toEqual({
			custom: { mode: "exact" },
		});
		expect(() => {
			callerParams.messages[0].content = "still caller-owned";
			callerParams.providerOptions.custom.mode = "still mutable";
		}).not.toThrow();
	});

	it("does not reject from an estimated output reserve", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "complete");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "x".repeat(5_000),
				maxTokens: 16_000,
			}),
		).resolves.toBe("complete");
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0][1]).toMatchObject({
			maxTokens: 16_000,
			providerOptions: {
				eliza: {
					modelInputBudget: { reserveTokens: 16_000, shouldReject: false },
				},
			},
		});
	});

	it("rejects an unserializable final request before dispatch", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});
		const cyclic: Record<string, unknown> = { canary: "cycle" };
		cyclic.self = cyclic;

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, { responseSchema: cyclic }),
		).rejects.toMatchObject({ code: "MODEL_INPUT_SERIALIZATION_FAILED" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("surfaces an authoritative provider rejection after complete dispatch", async () => {
		const runtime = makeRuntime();
		const small = vi.fn(async () => {
			throw new Error("authoritative provider context rejection");
		});
		const large = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_SMALL, small, "small", 100, {
			contextWindowTokens: 20_000,
			displayModel: "small-window",
		});
		runtime.registerModel(ModelType.TEXT_SMALL, large, "large", 10, {
			contextWindowTokens: 100_000,
			displayModel: "large-window",
		});
		const sentinel = `HEAD${"z".repeat(15_000)}TAIL`;

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				messages: [{ role: "user", content: sentinel }],
			}),
		).rejects.toThrow("authoritative provider context rejection");

		expect(small).toHaveBeenCalledTimes(1);
		expect(large).not.toHaveBeenCalled();
		expect(JSON.stringify(small.mock.calls[0][1].messages)).toContain(sentinel);
		expect(small.mock.calls[0][1].providerOptions).toMatchObject({
			eliza: {
				modelInputBudget: {
					contextWindowTokens: 20_000,
					estimationMode: "utf8-upper-bound",
					shouldReject: false,
				},
			},
		});
	});

	it("uses an explicit per-call model before the slot default", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "ok");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "dynamic", 10, {
			contextWindowTokens: 20_000,
			displayModel: "small-window",
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				model: "claude-sonnet-5",
				prompt: "x".repeat(15_000),
			}),
		).resolves.toBe("ok");
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
