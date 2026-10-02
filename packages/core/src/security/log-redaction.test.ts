/**
 * Regression test: redaction clones must survive String()/template coercion.
 * A null-prototype clone throws "Cannot convert object to primitive value"
 * inside sinks that coerce log args (e.g. React DevTools' patched console
 * methods), which crashed the web startup screen in <AppProviderInner>.
 * __proto__ protection comes from defineProperty, not the prototype, so
 * plain-object clones stay safe and coercible.
 */
import { describe, expect, it } from "vitest";
import {
	REDACTION_FAILED_VALUE,
	redactLogValue,
	redactTrailingArgs,
} from "./log-redaction.js";

describe("log-redaction clone coercion", () => {
	it("preserves non-callable coercion fields without allowing them to break sinks", () => {
		const [clone] = redactTrailingArgs([
			{ toString: "source data", valueOf: { apiKey: "fixture-secret" } },
		]);
		expect(String(clone)).toBe("[object Object]");
		expect(`${clone}`).toBe("[object Object]");
		expect(Number(clone)).toBeNaN();
		expect(clone).toEqual({
			toString: "source data",
			valueOf: { apiKey: "[REDACTED]" },
		});
	});

	it("keeps sanitized Error coercion when an own field shadows toString", () => {
		const error = new Error("fixture");
		Object.defineProperty(error, "toString", {
			value: "source data",
			enumerable: true,
		});
		const [clone] = redactTrailingArgs([error]);
		expect(String(clone)).toBe("Error: fixture");
		expect(clone).toBeInstanceOf(Error);
		expect(JSON.stringify(clone)).toContain('"toString":"source data"');
	});

	it("redactTrailingArgs clones survive String() coercion", () => {
		const [clone] = redactTrailingArgs([{ phase: "restoring-session" }]);
		expect(() => String(clone)).not.toThrow();
		// Plain-object coercion: the default tag, not a throw. Sinks that
		// interpolate (React DevTools' patched console) survive; structured
		// sinks still get the full enumerable payload.
		expect(String(clone)).toBe("[object Object]");
		expect(clone).toEqual({ phase: "restoring-session" });
	});

	it("Map/Set clones survive String() coercion", () => {
		expect(() =>
			String(redactLogValue(new Map([["k", "v"]]), new WeakSet(), 0)),
		).not.toThrow();
		expect(() =>
			String(redactLogValue(new Set(["v"]), new WeakSet(), 0)),
		).not.toThrow();
	});

	it("still neutralizes an own __proto__ key", () => {
		const payload = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
		const clone = redactLogValue(payload, new WeakSet(), 0) as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(clone, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(clone.ok).toBe(1);
	});

	it("still masks credential-named keys at depth", () => {
		const [clone] = redactTrailingArgs([
			{ nested: { apiKey: "sk-live-secret-value-12345" } },
		]);
		expect(JSON.stringify(clone)).not.toContain("sk-live-secret-value-12345");
		expect(JSON.stringify(clone)).toContain("[REDACTED]");
	});

	it("redactTrailingArgs still fails closed, never throws", () => {
		const evil = {};
		Object.defineProperty(evil, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter");
			},
		});
		expect(() => redactTrailingArgs([evil])).not.toThrow();
		expect(redactTrailingArgs([evil])).toEqual([
			expect.objectContaining({ boom: REDACTION_FAILED_VALUE }),
		]);
	});
});

describe("log-redaction shared references", () => {
	it("clones an object referenced from two keys at both", () => {
		const owner = { id: "u1", apiKey: "fixture-secret" };
		const clone = redactLogValue(
			{ requester: owner, assignee: owner },
			new WeakSet(),
			0,
		);

		expect(clone).toEqual({
			requester: { id: "u1", apiKey: "[REDACTED]" },
			assignee: { id: "u1", apiKey: "[REDACTED]" },
		});
	});

	it("keeps every repeated array element and error in trailing args", () => {
		const tag = { k: "v" };
		const error = new Error("db down");
		const [array, payload] = redactTrailingArgs([
			[tag, tag, tag],
			{ error, lastError: error },
		]) as [unknown[], Record<string, Error>];

		expect(array).toEqual([{ k: "v" }, { k: "v" }, { k: "v" }]);
		expect(payload.error).toBeInstanceOf(Error);
		expect(payload.lastError).toBeInstanceOf(Error);
		expect(payload.lastError.message).toBe("db down");
	});

	it("still collapses self, mutual, array, and Map cycles", () => {
		const self: Record<string, unknown> = { id: "self" };
		self.self = self;
		const left: Record<string, unknown> = { id: "left" };
		const right: Record<string, unknown> = { id: "right", left };
		left.right = right;
		const list: unknown[] = ["head"];
		list.push(list);
		const map = new Map<string, unknown>();
		map.set("map", map);

		const [selfClone, leftClone, listClone, mapClone] = redactTrailingArgs([
			self,
			left,
			list,
			map,
		]);

		expect(selfClone).toEqual({ id: "self", self: "[Circular]" });
		expect(leftClone).toEqual({
			id: "left",
			right: { id: "right", left: "[Circular]" },
		});
		expect(listClone).toEqual(["head", "[Circular]"]);
		expect(mapClone).toEqual({
			type: "Map",
			entries: [["map", "[Circular]"]],
		});
	});

	it("leaves the ancestor path when a nested walk throws", () => {
		const unlistable = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("lazy payload");
				},
			},
		);
		const holder = { inner: unlistable };

		const clone = redactLogValue(
			{ first: holder, second: holder },
			new WeakSet(),
			0,
		);

		expect(clone).toEqual({
			first: { inner: REDACTION_FAILED_VALUE },
			second: { inner: REDACTION_FAILED_VALUE },
		});
	});

	it("marks repeats past the budget so a densely shared graph stays linear", () => {
		// Five levels with ten keys each pointing at the next level: 10^4 paths
		// to the leaf through five distinct objects.
		let level: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 4; index += 1) {
			const next: Record<string, unknown> = {};
			for (let key = 0; key < 10; key += 1) next[`k${key}`] = level;
			level = next;
		}

		const clone = redactLogValue(level, new WeakSet(), 0);
		const markers: unknown[] = [];
		let clonedObjects = 0;
		const count = (value: unknown): void => {
			if (value && typeof value === "object") {
				clonedObjects += 1;
				for (const entry of Object.values(value)) count(entry);
			} else if (typeof value === "string") {
				markers.push(value);
			}
		};
		count(clone);

		expect(clonedObjects).toBeLessThanOrEqual(5 + 10_000);
		expect(markers.length).toBeGreaterThan(0);
		expect(new Set(markers)).toEqual(new Set(["[Shared]"]));
	});

	it("charges repeated text by length so re-scanning stays bounded", () => {
		const transcript = { text: "x".repeat(100_000) };
		const clone = redactLogValue(
			new Array(5000).fill(transcript),
			new WeakSet(),
			0,
		) as unknown[];

		const scanned = clone.filter(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				(entry as { text: string }).text.length === 100_000,
		);
		// One first pass plus at most 10,000 units of 256 characters re-scanned.
		expect(scanned.length * 100_000).toBeLessThanOrEqual(
			100_000 + 10_000 * 256,
		);
		expect(scanned.length).toBeGreaterThan(1);
		expect(clone.at(-1)).toBe("[Shared]");
	});

	it("does not spend the budget on repeated leaf built-ins", () => {
		const startedAt = new Date("2026-10-02T00:00:00.000Z");
		const clone = redactLogValue(
			new Array(20_000).fill(startedAt),
			new WeakSet(),
			0,
		) as unknown[];

		expect(new Set(clone)).toEqual(new Set(["2026-10-02T00:00:00.000Z"]));
	});

	it("keeps the budget finite when a repeated error has a non-string stack", () => {
		const error = new Error("bad stack");
		Object.defineProperty(error, "stack", { value: 42 });
		const item = { k: 1 };
		const clone = redactLogValue(
			{ first: error, second: error, items: new Array(20_000).fill(item) },
			new WeakSet(),
			0,
		) as { items: unknown[] };

		expect(clone.items.at(-1)).toBe("[Shared]");
	});
});
