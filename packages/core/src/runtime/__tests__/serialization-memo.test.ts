/**
 * Memoization of the planner-loop routing-hints prompt block. Exercises
 * `__renderRoutingHintsBlockForTests`: output is memoized on `context.events`
 * identity via a WeakMap, so repeated within-turn renders return the same bytes
 * for free (and drop when the context is GC'd), and the compress-mode env flag
 * suppresses rendering. Deterministic, no model.
 */
import { afterEach, describe, expect, it } from "vitest";

import { __renderRoutingHintsBlockForTests } from "../planner-loop";
import type { ContextObject } from "../planner-types";

interface ToolEvent {
	id: string;
	type: "tool";
	tool: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		action?: { routingHint?: string };
	};
}

function makeRoutingHintEvent(name: string, hint: string): ToolEvent {
	return {
		id: `tool-${name}`,
		type: "tool",
		tool: {
			name,
			description: `${name} action`,
			parameters: { type: "object", properties: {}, required: [] },
			action: { routingHint: hint },
		},
	};
}

function makeContextWithHints(count: number): ContextObject {
	const events = Array.from({ length: count }, (_, idx) =>
		makeRoutingHintEvent(
			`TEST_ACTION_${idx}`,
			`hint ${idx} -> TEST_ACTION_${idx}`,
		),
	);
	return { events } as unknown as ContextObject;
}

describe("planner-loop memoization", () => {
	afterEach(() => {
		delete process.env.ELIZA_PROMPT_COMPRESS;
	});

	it("renderRoutingHintsBlock returns the same bytes from memo as from a fresh compute", () => {
		const ctx = makeContextWithHints(5);
		const a = __renderRoutingHintsBlockForTests(ctx);
		const b = __renderRoutingHintsBlockForTests(ctx);
		const c = __renderRoutingHintsBlockForTests(ctx);
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(c).toBe(a);
		expect(a).toContain("# Routing hints");
		expect(a).toContain("TEST_ACTION_0");
	});

	it("compress-mode env flag suppresses routing-hint rendering", () => {
		const ctx = makeContextWithHints(3);
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		try {
			expect(__renderRoutingHintsBlockForTests(ctx)).toBeNull();
		} finally {
			delete process.env.ELIZA_PROMPT_COMPRESS;
		}
	});
});
