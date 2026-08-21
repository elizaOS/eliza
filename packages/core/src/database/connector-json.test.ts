/**
 * Exercises the shared connector JSON projection through descriptor-only,
 * bounded production exports before storage adapters persist or audit data.
 */

import { describe, expect, it } from "vitest";
import {
	CONNECTOR_JSON_BOUNDED,
	CONNECTOR_JSON_UNBOUNDED,
	cloneConnectorJsonObject,
	cloneConnectorJsonValue,
	MAX_CONNECTOR_JSON_DEPTH,
	MAX_CONNECTOR_JSON_NODES,
	MAX_CONNECTOR_JSON_STRING_BYTES,
	redactConnectorJsonAudit,
} from "./connector-json";

describe("connector JSON projection", () => {
	it("clones honest values without sharing mutable descendants", () => {
		const shared = { value: "kept" };
		const source = {
			list: [shared, null],
			repeated: shared,
			when: new Date("2026-01-02T03:04:05.000Z"),
		};

		const cloned = cloneConnectorJsonObject(source);
		expect(cloned).toEqual({
			list: [{ value: "kept" }, null],
			repeated: { value: "kept" },
			when: "2026-01-02T03:04:05.000Z",
		});
		(source.list[0] as { value: string }).value = "changed";
		expect(cloned.list).toEqual([{ value: "kept" }, null]);
	});

	it("rejects cycles, depth, width, and oversized leaves with one typed code", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let index = 0; index <= MAX_CONNECTOR_JSON_DEPTH; index += 1) {
			cursor.next = {};
			cursor = cursor.next as Record<string, unknown>;
		}
		const wide = Array.from({ length: MAX_CONNECTOR_JSON_NODES }, () => null);
		const oversized = "😀".repeat(MAX_CONNECTOR_JSON_STRING_BYTES / 4 + 1);

		for (const value of [cycle, deep, { wide }, { oversized }]) {
			expect(() => cloneConnectorJsonObject(value)).toThrowError(
				expect.objectContaining({ code: CONNECTOR_JSON_UNBOUNDED }),
			);
		}
	});

	it("rejects every non-JSON primitive without normalizing values", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			undefined,
			1n,
			Symbol("not-json"),
			() => undefined,
		]) {
			expect(() => cloneConnectorJsonObject({ value })).toThrowError(
				expect.objectContaining({ code: CONNECTOR_JSON_UNBOUNDED }),
			);
		}
	});

	it("bounds reflection before inspecting every property descriptor", () => {
		let descriptorCalls = 0;
		const keys = Array.from(
			{ length: MAX_CONNECTOR_JSON_NODES },
			(_, index) => `key-${index}`,
		);
		const target = Object.fromEntries(keys.map((key) => [key, null]));
		const wideProxy = new Proxy(target, {
			getOwnPropertyDescriptor(currentTarget, key) {
				descriptorCalls += 1;
				return Reflect.getOwnPropertyDescriptor(currentTarget, key);
			},
			ownKeys() {
				return keys;
			},
		});

		expect(() => cloneConnectorJsonObject(wideProxy)).toThrowError(
			expect.objectContaining({ code: CONNECTOR_JSON_UNBOUNDED }),
		);
		expect(descriptorCalls).toBe(0);
	});

	it("rejects oversized arrays before inspecting indexed descriptors", () => {
		let indexDescriptorCalls = 0;
		const wideArray = new Proxy(
			Array.from({ length: MAX_CONNECTOR_JSON_NODES }, () => null),
			{
				getOwnPropertyDescriptor(target, key) {
					if (key !== "length") indexDescriptorCalls += 1;
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			},
		);

		expect(() => cloneConnectorJsonObject({ wideArray })).toThrowError(
			expect.objectContaining({ code: CONNECTOR_JSON_UNBOUNDED }),
		);
		expect(indexDescriptorCalls).toBe(0);
	});

	it("never invokes accessors and rejects revoked or callable proxies", () => {
		let calls = 0;
		const accessor = Object.defineProperty({}, "secret", {
			enumerable: true,
			get() {
				calls += 1;
				return "leaked";
			},
		});
		const callable = new Proxy(() => undefined, {
			get() {
				calls += 1;
				return undefined;
			},
		});
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();

		for (const value of [
			accessor,
			{ callable },
			{ missing: undefined },
			revoked.proxy,
		]) {
			expect(() => cloneConnectorJsonObject(value)).toThrowError(
				expect.objectContaining({ code: CONNECTOR_JSON_UNBOUNDED }),
			);
		}
		expect(calls).toBe(0);
	});

	it("keeps audit events visible while redacting secrets and hostile branches", () => {
		let calls = 0;
		const metadata = Object.defineProperties(
			{ nonFinite: Number.NaN, token: "secret", safe: { value: "visible" } },
			{
				hostile: {
					enumerable: true,
					get() {
						calls += 1;
						return "leaked";
					},
				},
			},
		);

		expect(
			redactConnectorJsonAudit(metadata, (key) => key === "token"),
		).toEqual({
			nonFinite: CONNECTOR_JSON_BOUNDED,
			token: "[REDACTED]",
			safe: { value: "visible" },
			hostile: CONNECTOR_JSON_BOUNDED,
		});
		expect(calls).toBe(0);

		const revoked = Proxy.revocable<Record<string, unknown>>({}, {});
		revoked.revoke();
		expect(redactConnectorJsonAudit(revoked.proxy, () => false)).toEqual({
			bounded: CONNECTOR_JSON_BOUNDED,
		});
	});

	it("preserves literal bounded-marker strings in every projection mode", () => {
		const value = {
			list: [
				CONNECTOR_JSON_BOUNDED,
				"middle",
				[CONNECTOR_JSON_BOUNDED, "last"],
			],
		};

		expect(cloneConnectorJsonObject(value)).toEqual(value);
		expect(cloneConnectorJsonValue(value)).toEqual(value);
		expect(redactConnectorJsonAudit(value, () => false)).toEqual(value);
	});

	it("bounds hostile audit array elements without dropping honest siblings", () => {
		const cycle: unknown[] = [];
		cycle.push(cycle);
		const accessor = Object.defineProperty([], "0", {
			configurable: true,
			enumerable: true,
			get() {
				throw new Error("must not run");
			},
		});
		Object.defineProperty(accessor, "length", { value: 2 });
		Object.defineProperty(accessor, "1", {
			configurable: true,
			enumerable: true,
			value: "after-accessor",
		});

		const redacted = redactConnectorJsonAudit(
			{
				accessor,
				cycle: [cycle, "after-cycle"],
				unsupported: [1n, "after-bigint"],
			},
			() => false,
		);

		expect(redacted).toEqual({
			accessor: [CONNECTOR_JSON_BOUNDED, "after-accessor"],
			cycle: [[CONNECTOR_JSON_BOUNDED], "after-cycle"],
			unsupported: [CONNECTOR_JSON_BOUNDED, "after-bigint"],
		});
	});

	it("stops safely once the aggregate node budget is exhausted", () => {
		const values = Array.from({ length: MAX_CONNECTOR_JSON_NODES }, () => null);
		const redacted = redactConnectorJsonAudit(
			{ values, mustNotSurvive: "past-budget" },
			() => false,
		);

		expect(redacted.values).toBe(CONNECTOR_JSON_BOUNDED);
		expect(redacted).not.toHaveProperty("mustNotSurvive");
	});
});
