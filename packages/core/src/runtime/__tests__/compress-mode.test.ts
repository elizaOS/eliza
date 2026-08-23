/**
 * Exercises `ELIZA_PROMPT_COMPRESS` token-budget mode: the optimized-prompt
 * resolver keeps every few-shot demonstration regardless of the flag, and the
 * planner-loop routing-hints block is skipped when the env flag is set.
 * Deterministic — toggles the env var directly, no model.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { OptimizedPromptService } from "../../services/optimized-prompt";
import { resolveOptimizedPrompt } from "../../services/optimized-prompt-resolver";
import { __renderRoutingHintsBlockForTests } from "../planner-loop";
import type { ContextObject } from "../planner-types";

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

describe("retired ELIZA_PROMPT_COMPRESS mode", () => {
	afterEach(() => {
		delete process.env.ELIZA_PROMPT_COMPRESS;
	});

	it("keeps every few-shot demonstration in the resolved prompt even when enabled", () => {
		const service = makeService({
			prompt: "Base optimized prompt body.",
			fewShot: 4,
		});
		const baseline = "Untouched baseline";

		const before = resolveOptimizedPrompt(service, "message-handler", baseline);
		expect(before).toContain("Demonstrations:");
		expect(before).toContain("example user 0");

		// Prompt integrity (repository CLAUDE.md): model-facing content is never
		// dropped to fit a token budget. `ELIZA_PROMPT_COMPRESS` used to strip the
		// in-context demonstrations here; #24134 removed that so the flag can no
		// longer change what the model is taught from.
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const resolved = resolveOptimizedPrompt(
			service,
			"message-handler",
			baseline,
		);
		expect(resolved).toBe(before);
		expect(resolved).toContain("Demonstrations:");
		for (let i = 0; i < 4; i += 1) {
			expect(resolved).toContain(`example user ${i}`);
			expect(resolved).toContain(`example out ${i}`);
		}
	});

	it("falls back to baseline when no service is registered", () => {
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const out = resolveOptimizedPrompt(null, "message-handler", "BASELINE");
		expect(out).toBe("BASELINE");
	});

	it("cannot suppress routing-hint rendering", () => {
		const ctx = makeContext();
		const before = __renderRoutingHintsBlockForTests(ctx);
		expect(before).not.toBeNull();
		expect(before).toContain("# Routing hints");

		// Routing hints memo is keyed on context.events identity, so a fresh
		// context is needed to observe the env flag change.
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const rendered = __renderRoutingHintsBlockForTests(makeContext());
		expect(rendered).toContain("# Routing hints");
	});
});
