/**
 * Tests for ChatPreHandlerRegistry: priority ordering, pass-through and
 * abort propagation.
 */
import { describe, expect, it } from "vitest";
import type {
	ChatPreHandler,
	ChatPreHandlerContext,
} from "../types/chat-pre-handler.ts";
import { ChatPreHandlerRegistry } from "./chat-pre-handler-registry.ts";

const ctx = {
	runtime: {},
	message: {},
	appendText: () => {},
	replaceText: () => {},
} as unknown as ChatPreHandlerContext;

function handler(
	id: string,
	priority: number | undefined,
	responseText: string | null,
): ChatPreHandler {
	return {
		id,
		priority,
		async tryHandle() {
			return responseText === null ? null : { responseText };
		},
	};
}

describe("ChatPreHandlerRegistry", () => {
	it("starts empty", () => {
		const registry = new ChatPreHandlerRegistry();
		expect(registry.size).toBe(0);
		expect(registry.list()).toEqual([]);
	});

	it("registers a single handler and drains it", async () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a", 0, "resolved"));
		expect(registry.size).toBe(1);
		await expect(registry.drain(ctx)).resolves.toEqual({
			responseText: "resolved",
		});
	});

	it("registerMany registers all handlers", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([
			handler("a", 0, null),
			handler("b", 1, null),
			handler("c", undefined, null),
		]);
		expect(registry.size).toBe(3);
	});

	it("re-registering the same id replaces the handler", async () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a", 0, "first"));
		registry.register(handler("a", 0, "second"));
		expect(registry.size).toBe(1);
		await expect(registry.drain(ctx)).resolves.toEqual({
			responseText: "second",
		});
	});

	it("lists handlers in descending priority order", () => {
		const registry = new ChatPreHandlerRegistry();
		const low = handler("low", 1, null);
		const high = handler("high", 10, null);
		const none = handler("none", undefined, null);
		registry.register(low);
		registry.register(high);
		registry.register(none);
		expect(registry.list().map((h) => h.id)).toEqual(["high", "low", "none"]);
	});

	it("keeps insertion order for equal priorities", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("first", 5, null));
		registry.register(handler("second", 5, null));
		expect(registry.list().map((h) => h.id)).toEqual(["first", "second"]);
	});

	it("returns the first non-null result, skipping null handlers", async () => {
		const registry = new ChatPreHandlerRegistry();
		const calls: string[] = [];
		registry.register({
			id: "miss",
			priority: 10,
			async tryHandle() {
				calls.push("miss");
				return null;
			},
		});
		registry.register({
			id: "hit",
			priority: 5,
			async tryHandle() {
				calls.push("hit");
				return { responseText: "win" };
			},
		});
		await expect(registry.drain(ctx)).resolves.toEqual({
			responseText: "win",
		});
		expect(calls).toEqual(["miss", "hit"]);
	});

	it("stops draining after the first non-null result", async () => {
		const registry = new ChatPreHandlerRegistry();
		const calls: string[] = [];
		registry.register({
			id: "hit",
			priority: 10,
			async tryHandle() {
				calls.push("hit");
				return { responseText: "win" };
			},
		});
		registry.register({
			id: "later",
			priority: 1,
			async tryHandle() {
				calls.push("later");
				return { responseText: "never" };
			},
		});
		await expect(registry.drain(ctx)).resolves.toEqual({
			responseText: "win",
		});
		expect(calls).toEqual(["hit"]);
	});

	it("returns null when every handler passes through", async () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a", 0, null));
		registry.register(handler("b", 0, null));
		await expect(registry.drain(ctx)).resolves.toBeNull();
	});

	it("returns null when the registry is empty", async () => {
		const registry = new ChatPreHandlerRegistry();
		await expect(registry.drain(ctx)).resolves.toBeNull();
	});

	it("unregisters by id", async () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a", 0, "resolved"));
		registry.unregister("a");
		expect(registry.size).toBe(0);
		await expect(registry.drain(ctx)).resolves.toBeNull();
	});

	it("clears all handlers", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([handler("a", 0, null), handler("b", 0, null)]);
		registry.clear();
		expect(registry.size).toBe(0);
	});

	it("propagates an aborted signal before invoking a handler", async () => {
		const registry = new ChatPreHandlerRegistry();
		const controller = new AbortController();
		controller.abort();
		const invoked = {
			id: "a",
			priority: 0,
			async tryHandle() {
				return { responseText: "should not run" };
			},
		};
		registry.register(invoked);
		await expect(
			registry.drain({ ...ctx, abortSignal: controller.signal }),
		).rejects.toThrow("This operation was aborted");
	});

	it("propagates an aborted signal between handlers", async () => {
		const registry = new ChatPreHandlerRegistry();
		const controller = new AbortController();
		registry.register({
			id: "first",
			priority: 10,
			async tryHandle() {
				controller.abort();
				return null;
			},
		});
		registry.register(handler("second", 1, "never"));
		await expect(
			registry.drain({ ...ctx, abortSignal: controller.signal }),
		).rejects.toThrow("This operation was aborted");
	});
});
