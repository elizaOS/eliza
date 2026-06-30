import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(enabled: boolean): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "SecretSwapAgent",
			bio: "test",
			secrets: { WEBHOOK_SECRET: "whsec_1234567890abcdef" },
			settings: {
				ELIZA_SECRET_SWAP_ENABLED: enabled,
			},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("AgentRuntime.useModel secret swap", () => {
	it("sends placeholders to the model handler when enabled", async () => {
		const runtime = makeRuntime(true);
		let seenPrompt = "";
		const handler = vi.fn(async (_runtime, params: { prompt: string }) => {
			seenPrompt = params.prompt;
			return `received ${params.prompt}`;
		});
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "test");

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt:
				"Call webhook with WEBHOOK_SECRET=whsec_1234567890abcdef for ops@example.com.",
		});

		expect(handler).toHaveBeenCalledTimes(1);
		expect(seenPrompt).toContain("__ELIZA_SECRET_1__");
		expect(seenPrompt).toContain("__ELIZA_SECRET_2__");
		expect(seenPrompt).not.toContain("whsec_1234567890abcdef");
		expect(seenPrompt).not.toContain("ops@example.com");
		expect(result).toContain("__ELIZA_SECRET_1__");
		expect(result).not.toContain("whsec_1234567890abcdef");
	});

	it("preserves existing behavior when disabled", async () => {
		const runtime = makeRuntime(false);
		let seenPrompt = "";
		const handler = vi.fn(async (_runtime, params: { prompt: string }) => {
			seenPrompt = params.prompt;
			return "ok";
		});
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "test");

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Call webhook with WEBHOOK_SECRET=whsec_1234567890abcdef.",
		});

		expect(seenPrompt).toContain("whsec_1234567890abcdef");
		expect(seenPrompt).not.toContain("__ELIZA_SECRET_");
	});

	it("swaps secrets added by pre_model hooks before provider execution", async () => {
		const runtime = makeRuntime(true);
		let seenPrompt = "";
		runtime.registerPipelineHook({
			id: "inject-secret-after-initial-swap",
			phase: "pre_model",
			handler: (_runtime, ctx) => {
				if (
					ctx.phase === "pre_model" &&
					ctx.params &&
					typeof ctx.params === "object" &&
					"prompt" in ctx.params
				) {
					(ctx.params as { prompt: string }).prompt +=
						" late token sk-late_1234567890abcdef";
				}
			},
		});
		const handler = vi.fn(async (_runtime, params: { prompt: string }) => {
			seenPrompt = params.prompt;
			return "ok";
		});
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "test");

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Initial prompt",
		});

		expect(seenPrompt).toContain("__ELIZA_SECRET_");
		expect(seenPrompt).not.toContain("sk-late_1234567890abcdef");
	});
});
