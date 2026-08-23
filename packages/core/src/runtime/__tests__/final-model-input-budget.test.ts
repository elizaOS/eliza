/**
 * Exercises AgentRuntime final prepared-request budgeting with real routing,
 * pre-model hooks, failover, and provider handlers. Deterministic fake handlers
 * prove every text-generation slot rejects complete oversized input before
 * dispatch and that a later large-context registration can accept it unchanged.
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
		"rejects complete oversized %s input before its handler",
		async (modelType) => {
			const runtime = makeRuntime();
			const handler = vi.fn(async () => "must not run");
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
			).rejects.toMatchObject({
				code: "MODEL_INPUT_OVER_BUDGET",
				context: expect.objectContaining({
					provider: "tiny",
					modelName: "tiny-final-wire",
					contextWindowTokens: 20_000,
					estimationMode: "utf8-upper-bound",
					contextWindowSource: "registration-metadata",
				}),
			});
			expect(handler).not.toHaveBeenCalled();
		},
	);

	it("keeps a rejected complete request behind its owner-authorized opaque reference", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});
		const sentinel = `HEAD${"private-canary".repeat(1_500)}TAIL`;
		let rejection: unknown;
		try {
			await runtime.useModel(ModelType.TEXT_SMALL, { prompt: sentinel });
		} catch (error) {
			rejection = error;
		}
		const context = (rejection as { context?: Record<string, unknown> }).context;
		const receipt = context?.rejectedRequest as
			| { reference?: string; stored?: boolean }
			| undefined;
		expect(receipt).toMatchObject({ stored: true });
		expect(JSON.stringify(context)).not.toContain("private-canary");
		expect(
			runtime.readRejectedModelInput({
				reference: receipt?.reference as string,
				requesterAgentId: String(runtime.agentId),
			}),
		).toContain(sentinel);
		expect(() =>
			runtime.readRejectedModelInput({
				reference: receipt?.reference as string,
				requesterAgentId: "different-agent",
			}),
		).toThrow(expect.objectContaining({ code: "REJECTED_MODEL_INPUT_FORBIDDEN" }));
		expect(handler).not.toHaveBeenCalled();
	});

	it("checks content added by pre-model hooks", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "must not run");
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
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects an oversized provider-options-only payload before dispatch", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "small",
				providerOptions: { custom: { blob: "x".repeat(15_000) } },
			}),
		).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });
		expect(handler).not.toHaveBeenCalled();
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

	it("reserves the caller's requested output before dispatch", async () => {
		const runtime = makeRuntime();
		const handler = vi.fn(async () => "must not run");
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "tiny", 10, {
			contextWindowTokens: 20_000,
		});

		await expect(
			runtime.useModel(ModelType.TEXT_SMALL, {
				prompt: "x".repeat(5_000),
				maxTokens: 16_000,
			}),
		).rejects.toMatchObject({
			code: "MODEL_INPUT_OVER_BUDGET",
			context: expect.objectContaining({ reserveTokens: 16_000 }),
		});
		expect(handler).not.toHaveBeenCalled();
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

	it("skips a small registration and dispatches the same complete request to a fitting failover", async () => {
		const runtime = makeRuntime();
		const small = vi.fn(async () => "must not run");
		let captured: Record<string, unknown> | undefined;
		const large = vi.fn(async (_runtime, params: Record<string, unknown>) => {
			captured = params;
			return "ok";
		});
		runtime.registerModel(ModelType.TEXT_SMALL, small, "small", 100, {
			contextWindowTokens: 20_000,
			displayModel: "small-window",
		});
		runtime.registerModel(ModelType.TEXT_SMALL, large, "large", 10, {
			contextWindowTokens: 100_000,
			displayModel: "large-window",
		});
		const sentinel = `HEAD${"z".repeat(15_000)}TAIL`;

		await runtime.useModel(ModelType.TEXT_SMALL, {
			messages: [{ role: "user", content: sentinel }],
		});

		expect(small).not.toHaveBeenCalled();
		expect(large).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(captured?.messages)).toContain(sentinel);
		expect(captured?.providerOptions).toMatchObject({
			eliza: {
				modelInputBudget: {
					contextWindowTokens: 100_000,
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
