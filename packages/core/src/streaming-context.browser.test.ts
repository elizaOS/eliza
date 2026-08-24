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
		try {
			mgr.run("x", () => {
				throw new Error("boom");
			});
		} catch {}
		expect(mgr.active()).toBeUndefined();
	});
});
