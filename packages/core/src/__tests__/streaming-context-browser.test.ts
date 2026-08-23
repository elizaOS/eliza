import { describe, expect, it, vi } from "vitest";

vi.mock("./utils/stack-context-manager", () => {
	class MockBase {
		_stack: unknown[] = [];
		withContext<T>(ctx: unknown, fn: () => T): T {
			this._stack.push(ctx);
			try {
				return fn();
			} finally {
				this._stack.pop();
			}
		}
	}
	return { StackContextManager: MockBase };
});

import {
	createBrowserStreamingContextManager,
	StackContextManager,
} from "./streaming-context.browser.ts";

describe("createBrowserStreamingContextManager", () => {
	it("returns a StackContextManager instance", () => {
		const mgr = createBrowserStreamingContextManager();
		expect(mgr).toBeInstanceOf(StackContextManager);
	});

	it("supports nested contexts via push/pop", () => {
		const mgr = createBrowserStreamingContextManager();
		let inner: string | undefined;
		mgr.withContext("outer", () => {
			mgr.withContext("inner", () => {
				inner = String((mgr as unknown as { _stack: unknown[] })._stack.at(-1));
			});
		});
		expect(inner).toBe("inner");
		expect((mgr as unknown as { _stack: unknown[] })._stack).toHaveLength(0);
	});
});
