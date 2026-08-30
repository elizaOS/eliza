/**
 * Tests for streaming-context.browser — StackContextManager.
 */
import { describe, expect, it } from "vitest";
import {
	createBrowserStreamingContextManager,
	StackContextManager,
} from "./streaming-context.browser.ts";

describe("streaming-context.browser", () => {
	it("StackContextManager stacks contexts", () => {
		const mgr = new StackContextManager();
		expect(mgr.active()).toBeUndefined();
		mgr.run("a", () => {
			expect(mgr.active()).toBe("a");
			mgr.run("b", () => {
				expect(mgr.active()).toBe("b");
			});
			expect(mgr.active()).toBe("a");
		});
		expect(mgr.active()).toBeUndefined();
	});

	it("createBrowserStreamingContextManager returns manager", () => {
		const mgr = createBrowserStreamingContextManager();
		expect(mgr).toBeDefined();
		expect(mgr.active()).toBeUndefined();
	});

	it("restores after exception", () => {
		const mgr = new StackContextManager();
		expect(() =>
			mgr.run("x", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(mgr.active()).toBeUndefined();

		mgr.run("outer", () => {
			expect(() =>
				mgr.run("inner", () => {
					throw new Error("nested boom");
				}),
			).toThrow("nested boom");
			expect(mgr.active()).toBe("outer");
		});
		expect(mgr.active()).toBeUndefined();
	});
});
