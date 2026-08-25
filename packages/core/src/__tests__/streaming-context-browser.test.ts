/**
 * Unit coverage for the browser streaming-context manager. Exercises the real
 * `StackContextManager` from `streaming-context.browser.ts` through its public
 * `run`/`active` surface — no mocks, no AsyncLocalStorage, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
	createBrowserStreamingContextManager,
	StackContextManager,
} from "../streaming-context.browser.ts";
import type { StreamingContext } from "../streaming-context.ts";

const ctx = (messageId: string): StreamingContext => ({ messageId });

describe("createBrowserStreamingContextManager", () => {
	it("returns a StackContextManager instance", () => {
		expect(createBrowserStreamingContextManager()).toBeInstanceOf(
			StackContextManager,
		);
	});

	it("has no active context before any run", () => {
		expect(createBrowserStreamingContextManager().active()).toBeUndefined();
	});

	it("exposes the running context through active() and returns the callback result", () => {
		const mgr = createBrowserStreamingContextManager();
		const outer = ctx("outer");
		const result = mgr.run(outer, () => {
			expect(mgr.active()).toBe(outer);
			return "value";
		});
		expect(result).toBe("value");
		expect(mgr.active()).toBeUndefined();
	});

	it("restores the outer context after a nested run", () => {
		const mgr = createBrowserStreamingContextManager();
		const outer = ctx("outer");
		const inner = ctx("inner");
		const seen: (string | undefined)[] = [];

		mgr.run(outer, () => {
			seen.push(mgr.active()?.messageId);
			mgr.run(inner, () => {
				seen.push(mgr.active()?.messageId);
			});
			seen.push(mgr.active()?.messageId);
		});

		expect(seen).toEqual(["outer", "inner", "outer"]);
		expect(mgr.active()).toBeUndefined();
	});

	it("pops the context even when the callback throws", () => {
		const mgr = createBrowserStreamingContextManager();
		expect(() =>
			mgr.run(ctx("boom"), () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(mgr.active()).toBeUndefined();
	});

	it("supports an explicitly undefined context that masks the outer one", () => {
		const mgr = createBrowserStreamingContextManager();
		mgr.run(ctx("outer"), () => {
			mgr.run(undefined, () => {
				expect(mgr.active()).toBeUndefined();
			});
			expect(mgr.active()?.messageId).toBe("outer");
		});
	});

	it("keeps separate stacks per manager instance", () => {
		const a = createBrowserStreamingContextManager();
		const b = createBrowserStreamingContextManager();
		a.run(ctx("a"), () => {
			expect(b.active()).toBeUndefined();
		});
	});
});
