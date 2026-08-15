/**
 * Exercises the secret-swap ingress path in `AgentRuntime.useModel`: known
 * secrets become per-session nonce placeholders before the model handler sees
 * the prompt — including secrets added by pre_model hooks and secrets split
 * across stream chunks — and never leak in the output. Real runtime over the
 * in-memory adapter with a registered fake model handler; deterministic.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(
	enabled: boolean,
	extraSecrets: Record<string, string> = {},
): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "SecretSwapAgent",
			bio: "test",
			secrets: {
				WEBHOOK_SECRET: "whsec_1234567890abcdef",
				...extraSecrets,
			},
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

		// Placeholders are per-session nonce'd (`__ELIZA_SECRET_<nonce>_<n>__`) so
		// they cannot be forged from user/model text. PII swapping is disabled in
		// this fixture, so the secret vault remains the fail-closed owner of email.
		const placeholderRe = /__ELIZA_SECRET_[0-9a-f]{8,}_\d+__/g;
		expect(handler).toHaveBeenCalledTimes(1);
		expect(seenPrompt?.match(placeholderRe)).toHaveLength(2);
		expect(seenPrompt).not.toContain("whsec_1234567890abcdef");
		expect(seenPrompt).not.toContain("ops@example.com");
		expect(result).toMatch(placeholderRe);
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

	it("does not leak secrets split across stream chunks", async () => {
		const runtime = makeRuntime(true);
		const streamedChunks: string[] = [];
		async function* textStream() {
			yield "response whsec_123";
			yield "4567890abcdef done";
		}
		const handler = vi.fn(async () => ({
			text: Promise.resolve("response whsec_1234567890abcdef done"),
			textStream: textStream(),
			usage: Promise.resolve({}),
			finishReason: Promise.resolve("stop"),
		}));
		runtime.registerModel(ModelType.TEXT_SMALL, handler, "test");

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "stream this",
			stream: true,
			onStreamChunk: (chunk: string) => {
				streamedChunks.push(chunk);
			},
		});

		const placeholderRe = /__ELIZA_SECRET_[0-9a-f]{8,}_\d+__/;
		expect(streamedChunks.join("")).toMatch(placeholderRe);
		expect(streamedChunks.join("")).not.toContain("whsec_1234567890abcdef");
		expect(result).toMatch(placeholderRe);
		expect(result).not.toContain("whsec_1234567890abcdef");
	});

	it("enforces carry-safe streaming per call even when the global swap toggle is disabled", async () => {
		const runtime = makeRuntime(false, {
			BOUNDARY_SECRET: "alpha. omega",
		});
		const streamedChunks: string[] = [];
		let providerSawRuntimePolicy = false;
		async function* textStream() {
			yield "Leak alpha. o";
			yield "mega stays hidden. Safe close.";
		}
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_runtime, params: Record<string, unknown>) => {
				providerSawRuntimePolicy = "streamSecurity" in params;
				return {
					text: Promise.resolve(
						"Leak alpha. omega stays hidden. Safe close.",
					),
					textStream: textStream(),
					usage: Promise.resolve({}),
					finishReason: Promise.resolve("stop"),
				};
			},
			"test",
		);

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Describe the safe result.",
			stream: true,
			streamSecurity: "required",
			onStreamChunk: (chunk: string) => streamedChunks.push(chunk),
		});

		const visible = streamedChunks.join("");
		expect(providerSawRuntimePolicy).toBe(false);
		expect(visible).toContain("__ELIZA_SECRET_");
		expect(visible).not.toContain("alpha");
		expect(visible).not.toContain("omega");
		expect(String(result)).not.toContain("alpha");
		expect(String(result)).not.toContain("omega");
	});
});
