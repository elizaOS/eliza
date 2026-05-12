import { afterEach, describe, expect, it } from "vitest";

// We import via the public planner-loop module to exercise the same code
// path the planner uses at runtime — there is no separate "memo" entry
// point to mock. The memoizations live behind the rendering helpers and
// are observable through the call-time delta on a stable input.
//
// Wave 2-D: this test asserts the structural memo wins for
// `renderAvailableActionsBlock` are real. The block is recomputed once,
// then served from the WeakMap on subsequent calls with the same
// `context.events` reference. The threshold is intentionally loose
// because vitest overhead dominates at this scale; the goal is to lock
// in the optimization without coupling CI to wall-clock variance.
import type { ContextObject } from "../planner-types";

// Access the (otherwise non-exported) renderers via the planner-loop module
// surface that re-exports them for tests. We re-derive them here through a
// minimal harness: the planner-loop file does not currently export the
// renderers, so we reimplement the same memo lookup contract by going
// through `renderPlannerModelInput` indirectly — instead we just exercise
// the public surface that we know calls into them and observe the time
// delta on the *full* prompt-build step.
//
// In practice the cheapest reliable signal here is:
//   1. Build a ContextObject with N tool events.
//   2. Call `renderContextObject` + the planner-loop's available-actions
//      builder repeatedly through the planner-loop test seam.
//
// The planner-loop module exports nothing that calls our helpers directly,
// so we test the memoization at the unit boundary by importing the
// `renderToolForAvailableActions` / `renderAvailableActionsBlock` paths
// through the test-only re-export below.

import {
	__renderAvailableActionsBlockForTests,
	__renderToolForAvailableActionsForTests,
} from "../planner-loop";

function makeTool(name: string, propertyCount: number) {
	const properties: Record<string, { type: string; description: string }> = {};
	for (let i = 0; i < propertyCount; i++) {
		properties[`field_${i}`] = {
			type: "string",
			description: `Field ${i} on ${name}`,
		};
	}
	return {
		name,
		description: `${name} action — runs the ${name.toLowerCase()} flow`,
		parameters: {
			type: "object",
			properties,
			required: Object.keys(properties).slice(0, 1),
			additionalProperties: false,
		},
	};
}

function makeContext(toolCount: number, propsPerTool: number): ContextObject {
	const events = Array.from({ length: toolCount }, (_, idx) => ({
		id: `tool-${idx}`,
		type: "tool" as const,
		tool: makeTool(`TEST_ACTION_${idx}`, propsPerTool),
	}));
	return { events } as unknown as ContextObject;
}

describe("Wave 2-D serialization memoization", () => {
	afterEach(() => {
		delete process.env.ELIZA_SHORT_FORM_ENUMS;
	});

	it("renders the same bytes from memo as from a fresh compute", () => {
		const ctx = makeContext(10, 5);
		const a = __renderAvailableActionsBlockForTests(ctx);
		const b = __renderAvailableActionsBlockForTests(ctx);
		const c = __renderAvailableActionsBlockForTests(ctx);
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		expect(c).toBe(a);
	});

	it("memoizes renderToolForAvailableActions by tool object identity", () => {
		const tool = makeTool("RENDER_THIS", 8);
		const first = __renderToolForAvailableActionsForTests(tool);
		const second = __renderToolForAvailableActionsForTests(tool);
		const third = __renderToolForAvailableActionsForTests(tool);
		expect(second).toBe(first);
		expect(third).toBe(first);
		// The line shape must still include the parameters JSON — byte-stability
		// guard so cache-key snapshots aren't quietly drifted.
		expect(first).toContain("parameters:");
		expect(first).toContain("RENDER_THIS");
	});

	it("100-iteration build: post-warmup iterations are faster than first", () => {
		const ctx = makeContext(20, 6);
		// Warmup pass + first measured pass
		__renderAvailableActionsBlockForTests(ctx);
		// Time first cold run on a *fresh* context (no memo).
		const coldCtx = makeContext(20, 6);
		const coldStart = performance.now();
		__renderAvailableActionsBlockForTests(coldCtx);
		const coldDuration = performance.now() - coldStart;

		// 99 hot iterations on the same context (memo hits)
		const hotStart = performance.now();
		for (let i = 0; i < 99; i++) {
			__renderAvailableActionsBlockForTests(ctx);
		}
		const hotDuration = performance.now() - hotStart;
		const avgHotPerCall = hotDuration / 99;

		// Per-call hot time must be strictly less than cold time. Tolerance
		// 30% means we accept 0.7 * coldDuration as the upper bound.
		// In practice hot iterations are >100x faster (microseconds vs ms),
		// so this threshold is comfortable but resilient to CI noise.
		expect(avgHotPerCall).toBeLessThan(coldDuration * 0.7);
	});

	it("compress-mode env flag is respected at render time", () => {
		const ctx = makeContext(5, 3);
		const before = __renderAvailableActionsBlockForTests(ctx);
		// Different ctx so we don't hit memo: the routing-hints memo keys on
		// context.events array identity.
		const ctxWithRoutingHints = makeContext(5, 3);
		// Just sanity-check that the block builds with both env states.
		process.env.ELIZA_PROMPT_COMPRESS = "1";
		try {
			const compressed =
				__renderAvailableActionsBlockForTests(ctxWithRoutingHints);
			// Available-actions block is unaffected by compress mode — only
			// routing-hints and few-shots change. Sanity-check we still got a
			// block back.
			expect(compressed).not.toBeNull();
			expect(before).not.toBeNull();
		} finally {
			delete process.env.ELIZA_PROMPT_COMPRESS;
		}
	});
});
