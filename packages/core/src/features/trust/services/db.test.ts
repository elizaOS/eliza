/**
 * Unit coverage for the trust capability's database-handle resolution. The
 * real `getDb` executes against minimal deterministic runtime fixtures —
 * no database adapter, network, clock, or mocked module is involved.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import { getDb } from "./db.ts";

function runtimeWithDb(db: unknown): IAgentRuntime {
	return { db } as unknown as IAgentRuntime;
}

describe("getDb", () => {
	it("returns the runtime's attached db handle unchanged", () => {
		const db = { select: () => {}, insert: () => {} };
		expect(getDb(runtimeWithDb(db))).toBe(db);
	});

	it("resolves without touching the handle and forwards calls to it", () => {
		const select = vi.fn(() => ({ from: () => "row" }));
		const db = { select };
		const resolved = getDb(runtimeWithDb(db));
		expect(select).not.toHaveBeenCalled();
		expect(resolved).toBe(db);
		expect(resolved.select("id")?.from()).toBe("row");
		expect(select).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledWith("id");
	});

	it("throws when the runtime has no db property", () => {
		const runtime = {} as IAgentRuntime;
		expect(() => getDb(runtime)).toThrow("[trust] Database not available");
	});

	it("throws when the runtime db is undefined", () => {
		expect(() => getDb(runtimeWithDb(undefined))).toThrow(
			"[trust] Database not available",
		);
	});

	it("treats every falsy db value as unavailable", () => {
		for (const falsy of [null, 0, "", false]) {
			expect(() => getDb(runtimeWithDb(falsy))).toThrow(
				"[trust] Database not available",
			);
		}
	});

	it("passes through any truthy handle without validating its shape", () => {
		const primitiveHandle = "drizzle-handle";
		expect(getDb(runtimeWithDb(primitiveHandle))).toBe(primitiveHandle);
	});

	it("throws a plain Error whose message names the trust subsystem", () => {
		let caught: unknown;
		try {
			getDb({} as IAgentRuntime);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("[trust] Database not available");
	});
});
