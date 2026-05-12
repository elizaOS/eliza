import { afterEach, describe, expect, it } from "vitest";
import type { OptimizedPromptService } from "../../services/optimized-prompt";
import { resolveOptimizedPrompt } from "../../services/optimized-prompt-resolver";
import {
	__renderAvailableActionsBlockForTests,
	__renderRoutingHintsBlockForTests,
} from "../planner-loop";
import type { ContextObject } from "../planner-types";

// Wave 2-D: `ELIZA_PROMPT_COMPRESS=1` is the Cerebras token-budget escape
// hatch. Cache-key snapshots in `cache-key-stability.test.ts` are NOT
// expected to drift from this flag — the snapshots use a canonical
// non-resolver prefix without routing hints. The behavior change is
// observable here on the resolver + routing-hints renderer.

function makeService(args: {
	prompt: string;
	fewShot: number;
}): OptimizedPromptService {
	return {
		getPrompt: () => ({
			prompt: args.prompt,
			fewShotExamples: Array.from({ length: args.fewShot }, (_, i) => ({
				input: { user: `example user ${i}` },
				expectedOutput: `example out ${i}`,
			})),
		}),
	} as unknown as OptimizedPromptService;
}

function makeContext(): ContextObject {
	return {
		events: [
			{
				id: "tool-1",
				type: "tool" as const,
				tool: {
					name: "DO_THING",
					description: "does the thing",
					action: {
						name: "DO_THING",
						description: "does the thing",
						routingHint: "use DO_THING when the user asks for a thing",
						validate: async () => true,
						handler: async () => ({ success: true }),
					},
				},
			},
		],
	} as unknown as ContextObject;
}

describe("Wave 2-D compress mode (ELIZA_PROMPT_COMPRESS)", () => {
	afterEach(() => {
		delete process.env.ELIZA_PROMPT_COMPRESS;
	});

	it("drops few-shot demonstrations from the resolved prompt when enabled", () => {
		const service = makeService({
			prompt: "Base optimized prompt body.",
			fewShot: 4,
		});
		const baseline = "Untouched baseline";

		const before = resolveOptimizedPrompt(service, "message-handler", baseline);
		expect(before).toContain("Demonstrations:");
		expect(before).toContain("example user 0");

		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const compressed = resolveOptimizedPrompt(
			service,
			"message-handler",
			baseline,
		);
		expect(compressed).toBe("Base optimized prompt body.");
		expect(compressed).not.toContain("Demonstrations:");
		expect(compressed).not.toContain("example user 0");
	});

	it("falls back to baseline when no service is registered", () => {
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const out = resolveOptimizedPrompt(null, "message-handler", "BASELINE");
		expect(out).toBe("BASELINE");
	});

	it("skips routing-hint rendering when enabled", () => {
		const ctx = makeContext();
		const before = __renderRoutingHintsBlockForTests(ctx);
		expect(before).not.toBeNull();
		expect(before).toContain("# Routing hints");

		// Routing hints memo is keyed on context.events identity, so a fresh
		// context is needed to observe the env flag change.
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const compressed = __renderRoutingHintsBlockForTests(makeContext());
		expect(compressed).toBeNull();
	});

	it("does NOT change the available-actions block (only routing hints + few-shots compress)", () => {
		const ctx = makeContext();
		const before = __renderAvailableActionsBlockForTests(ctx);

		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const compressed = __renderAvailableActionsBlockForTests(makeContext());

		// Available-actions block bytes are identical — top-K capping happens
		// at the action-retrieval layer (action-retrieval.ts) before the
		// retrieved actions become tool events on the context.
		expect(compressed).toEqual(before);
	});
});
