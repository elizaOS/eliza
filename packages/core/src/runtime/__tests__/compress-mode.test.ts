/**
 * Proves the retired `ELIZA_PROMPT_COMPRESS` escape hatch cannot silently
 * omit few-shot demonstrations or planner routing hints. Deterministic —
 * toggles the environment variable directly, no model.
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

	it("cannot drop few-shot demonstrations", () => {
		const service = makeService({
			prompt: "Base optimized prompt body.",
			fewShot: 4,
		});
		const baseline = "Untouched baseline";

		const before = resolveOptimizedPrompt(service, "message-handler", baseline);
		expect(before).toContain("Demonstrations:");
		expect(before).toContain("example user 0");

		process.env.ELIZA_PROMPT_COMPRESS = "1";
		const resolved = resolveOptimizedPrompt(
			service,
			"message-handler",
			baseline,
		);
		expect(resolved).toContain("Demonstrations:");
		expect(resolved).toContain("example user 0");
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
