import { afterEach, describe, expect, it } from "vitest";

import { __renderRoutingHintsBlockForTests } from "../planner-loop";
import type { ContextObject } from "../planner-types";

// Wave 2-D: after the per-action-native-tools refactor, the
// "available_actions" prompt block is gone (action info now rides on the
// tools array). The only remaining memoized renderer covered here is the
// routing-hints block, which is keyed on `context.events` identity so
// within-turn recomputation is free. WeakMap; no leak when the context
// object is GC'd.

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
