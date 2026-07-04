/**
 * Ingress test for the PII pseudonymization layer (#10469 / #7007).
 *
 * Proves that with `ELIZA_PII_SWAP_ENABLED` the model provider receives a fluent
 * prompt containing *realistic surrogates* and ZERO real named-entity PII, that
 * the response/trajectory keep surrogates (never real values), and that the
 * layer is a pure no-op when disabled.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	GazetteerEntityRecognizer,
	PII_ENTITY_RECOGNIZER_SERVICE,
	type PiiEntityRecognizer,
	PseudonymSession,
} from "../../security/index.js";
import { runWithTrajectoryContext } from "../../trajectory-context";
import { type Character, ModelType } from "../../types";


function makeRuntime(enabled: boolean): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "PiiSwapAgent",
			bio: "test",
			settings: { ELIZA_PII_SWAP_ENABLED: enabled },
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

/** Stub the runtime's NER-recognizer service lookup (the seam
 * `createPiiSwapSession` reads) with a fixed-roster recognizer, without paying
 * the real service lifecycle. */
function injectNerService(
	runtime: AgentRuntime,
	entries: { kind: string; value: string }[],
): void {
	const recognizer: PiiEntityRecognizer = new GazetteerEntityRecognizer(
		entries,
	);
	const original = runtime.getService.bind(runtime);
	vi.spyOn(runtime, "getService").mockImplementation((name: string) =>
		name === PII_ENTITY_RECOGNIZER_SERVICE
			? ({ getRecognizer: () => recognizer } as never)
			: original(name),
	);
}

describe("AgentRuntime.useModel PII swap — ingress", () => {
	it("sends realistic surrogates (no real PII) to the provider via the injected NER service", async () => {
		const runtime = makeRuntime(true);
		injectNerService(runtime, [
			{ kind: "person", value: "Dana Whitfield" },
			{ kind: "org", value: "Acme Robotics" },
		]);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return `ack ${params.prompt}`;
			},
			"test",
		);

		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Email Dana Whitfield at Acme Robotics about the Q3 renewal.",
		});

		// The provider sees neither real entity.
		expect(seenPrompt).not.toContain("Dana Whitfield");
		expect(seenPrompt).not.toContain("Acme Robotics");
		// It sees a fluent prompt (surrogates, not opaque placeholders).
		expect(seenPrompt).not.toContain("__ELIZA");
		expect(seenPrompt).toMatch(/Email .+ at .+ about the Q3 renewal\./);
		// The response/trajectory keep surrogates — real PII never re-enters logs.
		expect(String(result)).not.toContain("Dana Whitfield");
		expect(String(result)).not.toContain("Acme Robotics");
	});

	it("logs sanitized prompts to the DB model-call log", async () => {
		const runtime = makeRuntime(true);
		injectNerService(runtime, [{ kind: "person", value: "Dana Whitfield" }]);
		const createLogs = vi.spyOn(runtime.adapter, "createLogs");
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => `ack ${params.prompt}`,
			"test",
		);

		await runWithTrajectoryContext(
			{ runId: "run-1", trajectoryStepId: "step-1" },
			() =>
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "Email Dana Whitfield about the renewal.",
				}),
		);

		expect(createLogs).toHaveBeenCalledTimes(1);
		const call = createLogs.mock.calls[0]?.[0]?.[0] as {
			body?: { prompt?: string };
		};
		expect(call.body?.prompt).not.toContain("Dana Whitfield");
		expect(call.body?.prompt).toMatch(/^Email .+ about the renewal\.$/);
	});

	it("swaps named entities using a pre-seeded turn session (reused across the turn)", async () => {
		const runtime = makeRuntime(true);
		const session = new PseudonymSession({
			salt: "fixed",
			recognizer: new GazetteerEntityRecognizer([
				{ kind: "person", value: "Dana Whitfield" },
			]),
		});
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		await runWithTrajectoryContext(
			{ runId: "run-1", piiSwapSession: session },
			() =>
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "Ping Dana Whitfield.",
				}),
		);

		const surrogate = session.entries[0]?.surrogate as string;
		expect(surrogate).toBeTruthy();
		expect(seenPrompt).toBe(`Ping ${surrogate}.`);
		expect(seenPrompt).not.toContain("Dana Whitfield");
	});

	it("restores streamed callback text while keeping the returned stream result pseudonymized", async () => {
		const runtime = makeRuntime(true);
		const streamedChunks: string[] = [];
		const session = new PseudonymSession({
			salt: "fixed",
			recognizer: new GazetteerEntityRecognizer([
				{ kind: "person", value: "Dana Whitfield" },
			]),
		});
		await session.learn("Dana Whitfield");
		const surrogate = session.entries[0]?.surrogate as string;
		async function* textStream() {
			yield `Tell ${surrogate.slice(0, 4)}`;
			yield `${surrogate.slice(4)} hello.`;
		}
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => ({
				text: Promise.resolve(`Tell ${surrogate} hello.`),
				textStream: textStream(),
				usage: Promise.resolve({}),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
		);

		const result = await runWithTrajectoryContext(
			{ runId: "run-stream", piiSwapSession: session },
			() =>
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "Ping Dana Whitfield.",
					stream: true,
					onStreamChunk: (chunk: string) => {
						streamedChunks.push(chunk);
					},
				}),
		);

		expect(streamedChunks.join("")).toBe("Tell Dana Whitfield hello.");
		expect(String(result)).toBe(`Tell ${surrogate} hello.`);
		expect(String(result)).not.toContain("Dana Whitfield");
	});

	it("pseudonymizes a street address with the built-in regex recognizer (no model needed)", async () => {
		const runtime = makeRuntime(true);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Ship it to 1600 Amphitheatre Parkway, Mountain View, CA.",
		});

		expect(seenPrompt).not.toContain("1600 Amphitheatre Parkway");
		expect(seenPrompt).toContain("Ship it to ");
	});

	it("re-applies the mapping to entities pre_model hooks copy in", async () => {
		const runtime = makeRuntime(true);
		injectNerService(runtime, [{ kind: "person", value: "Dana Whitfield" }]);
		runtime.registerPipelineHook({
			id: "copy-known-entity",
			phase: "pre_model",
			handler: (_runtime, ctx) => {
				if (
					ctx.phase === "pre_model" &&
					ctx.params &&
					typeof ctx.params === "object" &&
					"prompt" in ctx.params
				) {
					// The hook re-introduces an entity already learned from the prompt.
					(ctx.params as { prompt: string }).prompt += " (cc: Dana Whitfield)";
				}
			},
		});
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Email Dana Whitfield now.",
		});

		expect(seenPrompt).toContain("(cc: ");
		expect(seenPrompt).not.toContain("Dana Whitfield");
	});

	it("swaps PII in an IMAGE generation prompt (not skipped like binary models)", async () => {
		const runtime = makeRuntime(true);
		injectNerService(runtime, [{ kind: "person", value: "Dana Whitfield" }]);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.IMAGE,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return { url: "img://x" };
			},
			"test",
		);

		await runtime.useModel(ModelType.IMAGE, {
			prompt: "A watercolor portrait of Dana Whitfield in a garden.",
		});

		expect(seenPrompt).not.toContain("Dana Whitfield");
		expect(seenPrompt).toContain("A watercolor portrait of ");
	});

	it("does NOT swap TEXT_EMBEDDING input (embeds the real text for stable retrieval)", async () => {
		const runtime = makeRuntime(true);
		injectNerService(runtime, [{ kind: "person", value: "Dana Whitfield" }]);
		let seenText = "";
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async (_rt, params: { text: string }) => {
				seenText = params.text;
				return [0.1, 0.2];
			},
			"test",
		);

		await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: "Dana Whitfield asked about the renewal.",
		});

		// Embeddings must stay stable turn-to-turn, so the real text is embedded.
		expect(seenText).toContain("Dana Whitfield");
	});

	it("degrades to regex-only (never crashes the call) when the NER recognizer throws", async () => {
		const runtime = makeRuntime(true);
		// A recognizer service whose recognizer always throws.
		vi.spyOn(runtime, "getService").mockImplementation((name: string) =>
			name === PII_ENTITY_RECOGNIZER_SERVICE
				? ({
						getRecognizer: () => ({
							name: "boom",
							recognize: async () => {
								throw new Error("model backend exploded");
							},
						}),
					} as never)
				: null,
		);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		// The call must succeed; the built-in regex recognizer still swaps the
		// address even though the NER recognizer blew up.
		const result = await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Mail it to 1600 Amphitheatre Parkway, Mountain View, CA.",
		});
		expect(result).toBe("ok");
		expect(seenPrompt).not.toContain("1600 Amphitheatre Parkway");
	});

	it("composes with the secret-swap layer (both enabled): secret → placeholder, name → surrogate", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "PiiSwapAgent",
				bio: "test",
				secrets: { WEBHOOK_SECRET: "whsec_composeSecret1234567890" },
				settings: {
					ELIZA_PII_SWAP_ENABLED: true,
					ELIZA_SECRET_SWAP_ENABLED: true,
				},
			} as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		injectNerService(runtime, [{ kind: "person", value: "Dana Whitfield" }]);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt:
				"Send WEBHOOK_SECRET=whsec_composeSecret1234567890 to Dana Whitfield.",
		});

		// The two layers do not clobber each other: the secret becomes an opaque
		// placeholder, the name becomes a realistic surrogate; neither is real.
		expect(seenPrompt).not.toContain("whsec_composeSecret1234567890");
		expect(seenPrompt).not.toContain("Dana Whitfield");
		expect(seenPrompt).toMatch(/__ELIZA_SECRET_/);
		expect(seenPrompt).toMatch(/to [A-Z][a-z]+ [A-Z][a-z]+\./);
	});

	it("is a pure no-op when disabled", async () => {
		const runtime = makeRuntime(false);
		let seenPrompt = "";
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async (_rt, params: { prompt: string }) => {
				seenPrompt = params.prompt;
				return "ok";
			},
			"test",
		);

		await runtime.useModel(ModelType.TEXT_SMALL, {
			prompt: "Email Dana Whitfield at Acme Robotics.",
		});

		expect(seenPrompt).toContain("Dana Whitfield");
		expect(seenPrompt).toContain("Acme Robotics");
	});
});
