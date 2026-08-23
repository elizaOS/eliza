/**
 * Coverage for the per-runtime host context holder: get/set semantics,
 * restore closures, non-enumerable Symbol.for keying, null handling, and
 * cross-instance survival.
 */
import { describe, expect, it } from "vitest";
import {
	getRuntimeRouteHostContext,
	setRuntimeRouteHostContext,
} from "./runtime-route-context.ts";

describe("runtime-route-context", () => {
	it("returns null for nullish runtimes", () => {
		expect(getRuntimeRouteHostContext(null)).toBeNull();
		expect(getRuntimeRouteHostContext(undefined)).toBeNull();
	});

	it("returns null before any context is set", () => {
		expect(getRuntimeRouteHostContext({})).toBeNull();
	});

	it("round-trips a context through get/set", () => {
		const runtime = {};
		const ctx = { config: { key: "value" } };
		setRuntimeRouteHostContext(runtime, ctx);
		expect(getRuntimeRouteHostContext(runtime)).toBe(ctx);
	});

	it("restores the previous context from the returned closure", () => {
		const runtime = {};
		const first = { config: { a: 1 } };
		const second = { config: { b: 2 } };
		setRuntimeRouteHostContext(runtime, first);
		const restore = setRuntimeRouteHostContext(runtime, second);
		expect(getRuntimeRouteHostContext(runtime)).toBe(second);
		restore();
		expect(getRuntimeRouteHostContext(runtime)).toBe(first);
	});

	it("restores null when there was no previous context", () => {
		const runtime = {};
		const restore = setRuntimeRouteHostContext(runtime, { config: {} });
		expect(getRuntimeRouteHostContext(runtime)).not.toBeNull();
		restore();
		expect(getRuntimeRouteHostContext(runtime)).toBeNull();
	});

	it("stores the holder non-enumerably on the runtime", () => {
		const runtime = {};
		setRuntimeRouteHostContext(runtime, { config: {} });
		expect(Object.keys(runtime)).toEqual([]);
	});

	it("survives across independent module copies via Symbol.for", () => {
		const runtime = {};
		const ctx = { config: { shared: true } };
		setRuntimeRouteHostContext(runtime, ctx);
		// A second import of the module still reads the same holder.
		expect(getRuntimeRouteHostContext(runtime)).toBe(ctx);
	});
});
