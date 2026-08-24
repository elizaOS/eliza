/**
 * Unit tests for browser streaming context manager.
 * Exercises stack-based context propagation, active context isolation, and nested scopes.
 */
import { describe, expect, it } from "vitest";
import {
	createBrowserStreamingContextManager,
	StackContextManager,
	type StreamingContext,
} from "../streaming-context.browser.ts";

describe("streaming-context.browser", () => {
	describe("createBrowserStreamingContextManager", () => {
		it("creates an instance of StackContextManager", () => {
			const manager = createBrowserStreamingContextManager();
			expect(manager).toBeInstanceOf(StackContextManager);
		});
	});

	describe("StackContextManager", () => {
		it("returns undefined when no context is active", () => {
			const manager = new StackContextManager();
			expect(manager.active()).toBeUndefined();
		});

		it("binds active context during run execution and restores prior context", () => {
			const manager = new StackContextManager();
			const contextA: StreamingContext = {
				runtimeId: "agent-1",
				messageId: "msg-100",
				roomId: "room-abc",
			};

			const result = manager.run(contextA, () => {
				expect(manager.active()).toEqual(contextA);
				return "completed-a";
			});

			expect(result).toBe("completed-a");
			expect(manager.active()).toBeUndefined();
		});

		it("supports nested context stacks cleanly", () => {
			const manager = new StackContextManager();
			const outerCtx: StreamingContext = {
				runtimeId: "outer-agent",
				messageId: "outer-msg",
				roomId: "outer-room",
			};
			const innerCtx: StreamingContext = {
				runtimeId: "inner-agent",
				messageId: "inner-msg",
				roomId: "inner-room",
			};

			manager.run(outerCtx, () => {
				expect(manager.active()).toEqual(outerCtx);
				manager.run(innerCtx, () => {
					expect(manager.active()).toEqual(innerCtx);
				});
				expect(manager.active()).toEqual(outerCtx);
			});

			expect(manager.active()).toBeUndefined();
		});
	});
});
