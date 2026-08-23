/**
 * Unit coverage for ChatPreHandlerRegistry in chat-pre-handler-registry.ts.
 *
 * Tests registration, batch registration, unregistration, clearing,
 * priority sorting, drain sequence evaluation, and abort signal handling.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ChatPreHandler,
	ChatPreHandlerContext,
	ChatPreHandlerResult,
} from "../types/chat-pre-handler.js";
import { ChatPreHandlerRegistry } from "./chat-pre-handler-registry.js";

describe("ChatPreHandlerRegistry", () => {
	it("registers, lists, and unregisters handlers by id", () => {
		const registry = new ChatPreHandlerRegistry();

		const handlerA: ChatPreHandler = {
			id: "handler-a",
			priority: 10,
			tryHandle: vi.fn(),
		};
		const handlerB: ChatPreHandler = {
			id: "handler-b",
			priority: 20,
			tryHandle: vi.fn(),
		};

		registry.registerMany([handlerA, handlerB]);
		expect(registry.size).toBe(2);

		// Sorted by descending priority: B (20) then A (10)
		expect(registry.list()).toEqual([handlerB, handlerA]);

		registry.unregister("handler-a");
		expect(registry.size).toBe(1);
		expect(registry.list()).toEqual([handlerB]);

		registry.clear();
		expect(registry.size).toBe(0);
		expect(registry.list()).toEqual([]);
	});

	it("drains handlers in descending priority order and returns the first non-null result", async () => {
		const registry = new ChatPreHandlerRegistry();
		const callOrder: string[] = [];

		const expectedResult: ChatPreHandlerResult = {
			response: {
				text: "handled",
			},
		};

		const handlerLow: ChatPreHandler = {
			id: "low",
			priority: 5,
			tryHandle: vi.fn(async () => {
				callOrder.push("low");
				return null;
			}),
		};

		const handlerMid: ChatPreHandler = {
			id: "mid",
			priority: 50,
			tryHandle: vi.fn(async () => {
				callOrder.push("mid");
				return expectedResult;
			}),
		};

		const handlerHigh: ChatPreHandler = {
			id: "high",
			priority: 100,
			tryHandle: vi.fn(async () => {
				callOrder.push("high");
				return null;
			}),
		};

		registry.registerMany([handlerLow, handlerMid, handlerHigh]);

		const ctx = {} as ChatPreHandlerContext;
		const result = await registry.drain(ctx);

		expect(result).toBe(expectedResult);
		expect(callOrder).toEqual(["high", "mid"]);
		expect(handlerLow.tryHandle).not.toHaveBeenCalled();
	});

	it("returns null from drain when all handlers yield null", async () => {
		const registry = new ChatPreHandlerRegistry();

		const handler: ChatPreHandler = {
			id: "noop",
			tryHandle: vi.fn(async () => null),
		};

		registry.register(handler);

		const ctx = {} as ChatPreHandlerContext;
		const result = await registry.drain(ctx);

		expect(result).toBeNull();
	});

	it("throws if abortSignal is aborted before or during handler execution", async () => {
		const registry = new ChatPreHandlerRegistry();
		const handler: ChatPreHandler = {
			id: "test",
			tryHandle: vi.fn(),
		};
		registry.register(handler);

		const controller = new AbortController();
		controller.abort();

		const ctx = {
			abortSignal: controller.signal,
		} as unknown as ChatPreHandlerContext;

		await expect(registry.drain(ctx)).rejects.toThrow();
	});
});
