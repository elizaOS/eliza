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

/**
 * Ingress test for the PII pseudonymization layer (#10469 / #7007).
 *
 * Proves that with `ELIZA_PII_SWAP_ENABLED` the model provider receives a fluent
 * prompt containing *realistic surrogates* and ZERO real named-entity PII, that
 * the response/trajectory keep surrogates (never real values), and that the
 * layer is a pure no-op when disabled.
 */

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
