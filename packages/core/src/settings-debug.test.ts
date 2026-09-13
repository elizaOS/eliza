import { describe, expect, it } from "vitest";
import {
	isElizaSettingsDebugEnabled,
	MAX_STRING,
	sanitizeDebugString,
	sanitizeForSettingsDebug,
} from "./settings-debug.js";

describe("settings-debug", () => {
	it("exposes MAX_STRING constant", () => {
		expect(MAX_STRING).toBe(120);
	});

	it("detects enabled via env", () => {
		expect(
			isElizaSettingsDebugEnabled({ env: { ELIZA_SETTINGS_DEBUG: "1" } }),
		).toBe(true);
		expect(
			isElizaSettingsDebugEnabled({
				env: { VITE_ELIZA_SETTINGS_DEBUG: "true" },
			}),
		).toBe(true);
		expect(isElizaSettingsDebugEnabled({ env: {} })).toBe(false);
	});

	it("detects enabled via importMetaEnv", () => {
		expect(
			isElizaSettingsDebugEnabled({
				importMetaEnv: { ELIZA_SETTINGS_DEBUG: "1" },
			}),
		).toBe(true);
		expect(
			isElizaSettingsDebugEnabled({
				importMetaEnv: { VITE_ELIZA_SETTINGS_DEBUG: "on" },
			}),
		).toBe(true);
		expect(isElizaSettingsDebugEnabled({ importMetaEnv: {} })).toBe(false);
	});

	it("sanitizes strings", () => {
		expect(sanitizeDebugString("")).toBe("");
		expect(sanitizeDebugString("[REDACTED]")).toBe("[REDACTED]");
		expect(sanitizeDebugString("  hello  ")).toBe("hello");
		const long = `sk-${"a".repeat(60)}`;
		const masked = sanitizeDebugString(long);
		expect(masked).toContain("chars)");
		expect(masked).not.toBe(long);
	});
});

describe("sanitizeForSettingsDebug reference handling", () => {
	it("renders a shared (non-cyclic) reference in full at every site", () => {
		// The same object reached from two keys and twice inside an array is a
		// DAG, not a cycle; every reference must sanitize to the same snapshot.
		const shared = { model: "gpt", region: "eu" };
		const out = sanitizeForSettingsDebug({
			a: shared,
			b: shared,
			list: [shared, shared],
		}) as Record<string, unknown>;
		const expected = { model: "gpt", region: "eu" };
		expect(out.a).toEqual(expected);
		expect(out.b).toEqual(expected);
		expect(out.list).toEqual([expected, expected]);
	});

	it("still collapses a true cycle to [circular] and sanitizes its siblings", () => {
		const root: Record<string, unknown> = { name: "root" };
		root.self = root;
		root.child = { parent: root, tag: "t" };
		expect(sanitizeForSettingsDebug(root)).toEqual({
			name: "root",
			self: "[circular]",
			child: { parent: "[circular]", tag: "t" },
		});
	});

	it("bounds a shared-reference chain instead of expanding it exponentially", () => {
		// 13 distinct objects inside the depth cap, each holding the same next
		// level under four keys: 4^12 paths. The snapshot must stop at the node
		// ceiling (20 000 emitted values), not at the heap.
		let level: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < 12; i++) {
			level = { a: level, b: level, c: level, d: level };
		}
		const started = performance.now();
		const out = sanitizeForSettingsDebug(level);
		const elapsedMs = performance.now() - started;
		let budgeted = 0;
		let markers = 0;
		const walk = (value: unknown): void => {
			if (value === "[max-size]") {
				markers += 1;
				return;
			}
			budgeted += 1;
			if (Array.isArray(value)) for (const item of value) walk(item);
			else if (value && typeof value === "object")
				for (const item of Object.values(value)) walk(item);
		};
		walk(out);
		expect(markers).toBeGreaterThan(0);
		expect(budgeted).toBeLessThanOrEqual(20_000);
		expect(elapsedMs).toBeLessThan(2_000);
	});
});
