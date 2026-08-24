/**
 * Unit tests for the chat pre-handler registry (`ChatPreHandlerRegistry`):
 * per-registry registration and replacement, descending-priority ordering with
 * stable ties, removal semantics, and the drain loop that runs handlers in
 * order, short-circuits on the first non-null result, and honors the turn's
 * abort signal before and after every handler. Pure deterministic harness —
 * real registry instances with hand-written handlers; no model, no DB.
 */

import { describe, expect, it } from "vitest";
import type {
	ChatPreHandler,
	ChatPreHandlerContext,
	ChatPreHandlerResult,
} from "../types/chat-pre-handler";
import { ChatPreHandlerRegistry } from "./chat-pre-handler-registry";

function makeContext(
	abortSignal?: AbortSignal,
): ChatPreHandlerContext & { streamed: string[] } {
	const streamed: string[] = [];
	return {
		runtime: {} as never,
		message: {} as never,
		abortSignal,
		appendText: (text) => {
			streamed.push(text);
		},
		replaceText: () => {},
		streamed,
	};
}

function handler(
	id: string,
	options: {
		priority?: number;
		result?: ChatPreHandlerResult | null;
		onHandle?: (ctx: ChatPreHandlerContext) => void;
	} = {},
): ChatPreHandler {
	return {
		id,
		priority: options.priority,
		tryHandle: async (ctx) => {
			options.onHandle?.(ctx);
			return options.result ?? null;
		},
	};
}

describe("ChatPreHandlerRegistry: registration", () => {
	it("starts empty", () => {
		const registry = new ChatPreHandlerRegistry();
		expect(registry.size).toBe(0);
		expect(registry.list()).toEqual([]);
	});

	it("registers a handler and exposes it from list", () => {
		const registry = new ChatPreHandlerRegistry();
		const h = handler("a");
		registry.register(h);
		expect(registry.size).toBe(1);
		expect(registry.list()).toEqual([h]);
	});

	it("replaces a handler re-registered under the same id in place", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a", { priority: 1 }));
		registry.register(handler("b"));
		registry.register(handler("a", { priority: 0 }));
		expect(registry.size).toBe(2);
		expect(registry.list().map((h) => h.id)).toEqual(["a", "b"]);
	});

	it("registers many handlers via registerMany", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([handler("a"), handler("b"), handler("c")]);
		expect(registry.list().map((h) => h.id)).toEqual(["a", "b", "c"]);
	});
});

describe("ChatPreHandlerRegistry: ordering", () => {
	it("lists handlers by descending priority", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([
			handler("low", { priority: -1 }),
			handler("high", { priority: 10 }),
			handler("mid", { priority: 3 }),
		]);
		expect(registry.list().map((h) => h.id)).toEqual(["high", "mid", "low"]);
	});

	it("treats a missing priority as zero", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([
			handler("default"),
			handler("negative", { priority: -5 }),
			handler("zero", { priority: 0 }),
		]);
		expect(registry.list().map((h) => h.id)).toEqual([
			"default",
			"zero",
			"negative",
		]);
	});

	it("keeps insertion order for tied priorities, including after replacement", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([
			handler("first"),
			handler("second"),
			handler("third"),
		]);
		expect(registry.list().map((h) => h.id)).toEqual([
			"first",
			"second",
			"third",
		]);
		registry.register(handler("second", { priority: 0 }));
		expect(registry.list().map((h) => h.id)).toEqual([
			"first",
			"second",
			"third",
		]);
	});
});

describe("ChatPreHandlerRegistry: removal", () => {
	it("unregisters an existing id", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([handler("a"), handler("b")]);
		registry.unregister("a");
		expect(registry.size).toBe(1);
		expect(registry.list().map((h) => h.id)).toEqual(["b"]);
	});

	it("ignores unregistering an id that was never registered", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(handler("a"));
		registry.unregister("missing");
		expect(registry.size).toBe(1);
		expect(registry.list().map((h) => h.id)).toEqual(["a"]);
	});

	it("clears every handler", () => {
		const registry = new ChatPreHandlerRegistry();
		registry.registerMany([handler("a"), handler("b")]);
		registry.clear();
		expect(registry.size).toBe(0);
		expect(registry.list()).toEqual([]);
	});
});

describe("ChatPreHandlerRegistry: drain", () => {
	it("returns null when no handlers are registered", async () => {
		const registry = new ChatPreHandlerRegistry();
		const ctx = makeContext();
		await expect(registry.drain(ctx)).resolves.toBe(null);
	});

	it("returns null when every handler passes through", async () => {
		const registry = new ChatPreHandlerRegistry();
		const called: string[] = [];
		registry.registerMany([
			handler("a", { result: null, onHandle: () => called.push("a") }),
			handler("b", { result: null, onHandle: () => called.push("b") }),
		]);
		await expect(registry.drain(makeContext())).resolves.toBe(null);
		expect(called).toEqual(["a", "b"]);
	});

	it("runs handlers in descending priority order", async () => {
		const registry = new ChatPreHandlerRegistry();
		const called: string[] = [];
		registry.registerMany([
			handler("low", { priority: -2, onHandle: () => called.push("low") }),
			handler("high", { priority: 8, onHandle: () => called.push("high") }),
			handler("mid", { priority: 4, onHandle: () => called.push("mid") }),
		]);
		await expect(registry.drain(makeContext())).resolves.toBe(null);
		expect(called).toEqual(["high", "mid", "low"]);
	});

	it("short-circuits on the first non-null result and skips later handlers", async () => {
		const registry = new ChatPreHandlerRegistry();
		const called: string[] = [];
		const winning: ChatPreHandlerResult = { responseText: "handled" };
		registry.registerMany([
			handler("pass", {
				priority: 5,
				result: null,
				onHandle: () => called.push("pass"),
			}),
			handler("winner", {
				priority: 1,
				result: winning,
				onHandle: () => called.push("winner"),
			}),
			handler("never", { priority: -1, onHandle: () => called.push("never") }),
		]);
		await expect(registry.drain(makeContext())).resolves.toBe(winning);
		expect(called).toEqual(["pass", "winner"]);
	});

	it("passes the same context instance to each handler", async () => {
		const registry = new ChatPreHandlerRegistry();
		const ctx = makeContext();
		const seen: ChatPreHandlerContext[] = [];
		registry.registerMany([
			handler("a", { onHandle: (c) => seen.push(c) }),
			handler("b", { onHandle: (c) => seen.push(c) }),
		]);
		await registry.drain(ctx);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(ctx);
		expect(seen[1]).toBe(ctx);
	});

	it("delivers stream callbacks made by a handler through the context", async () => {
		const registry = new ChatPreHandlerRegistry();
		registry.register(
			handler("streamer", {
				priority: 1,
				result: { responseText: "done" },
				onHandle: (ctx) => {
					ctx.appendText("thinking…");
					ctx.replaceText("final");
				},
			}),
		);
		const ctx = makeContext();
		await registry.drain(ctx);
		expect(ctx.streamed).toEqual(["thinking…"]);
	});
});

describe("ChatPreHandlerRegistry: abort handling", () => {
	it("rejects without invoking any handler when the signal is already aborted", async () => {
		const registry = new ChatPreHandlerRegistry();
		const controller = new AbortController();
		controller.abort();
		const called: string[] = [];
		registry.registerMany([
			handler("a", {
				result: { responseText: "x" },
				onHandle: () => called.push("a"),
			}),
			handler("b", { onHandle: () => called.push("b") }),
		]);
		await expect(
			registry.drain(makeContext(controller.signal)),
		).rejects.toThrowError();
		expect(called).toEqual([]);
	});

	it("stops between handlers when the signal aborts during an earlier handler", async () => {
		const registry = new ChatPreHandlerRegistry();
		const controller = new AbortController();
		const called: string[] = [];
		registry.registerMany([
			handler("first", {
				result: null,
				onHandle: () => {
					called.push("first");
					controller.abort();
				},
			}),
			handler("second", { onHandle: () => called.push("second") }),
		]);
		await expect(
			registry.drain(makeContext(controller.signal)),
		).rejects.toThrowError();
		expect(called).toEqual(["first"]);
	});
});
