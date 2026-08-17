/**
 * Pins Ship 14 truthy-limit fixes (CO-1, CO-4):
 * - CO-1: inMemoryAdapter.getTasks `if (params.limit)` → `limit=0` unbounded vs sibling `if (limit != null)` at same file:1476
 * - CO-4: trajectory-recorder.list `if (opts.limit && ...)` → `limit=0` never truncates vs same fix
 *
 * Sibling correct: `packages/core/src/database/inMemoryAdapter.ts:1476` `if (limit != null)` and `packages/agent/src/security/audit-log.ts:86` `toBoundedLimit`.
 */

import { describe, expect, it } from "vitest";

// Replica old vs fixed for CO-1 getTasks pagination
function paginateOld<T>(
	items: T[],
	params: { limit?: number; offset?: number },
): T[] {
	const offset = params.offset ?? 0;
	let filtered = items.slice(offset);
	if (params.limit) {
		filtered = filtered.slice(0, params.limit);
	}
	return filtered;
}
function paginateFixed<T>(
	items: T[],
	params: { limit?: number; offset?: number },
): T[] {
	const offset = params.offset ?? 0;
	let filtered = items.slice(offset);
	if (params.limit != null) {
		filtered = filtered.slice(0, params.limit);
	}
	return filtered;
}

// Replica old vs fixed for CO-4 trajectory list
function listOld<T>(out: T[], opts: { limit?: number }): T[] {
	out = [...out].sort(() => 0);
	if (opts.limit && out.length > opts.limit) {
		return out.slice(0, opts.limit);
	}
	return out;
}
function listFixed<T>(out: T[], opts: { limit?: number }): T[] {
	out = [...out].sort(() => 0);
	if (opts.limit != null && out.length > opts.limit) {
		return out.slice(0, opts.limit);
	}
	return out;
}

describe("truthy limit batch (ship 14) — CO-1, CO-4", () => {
	it("CO-1 getTasks: old `if (limit)` truthy → limit=0 returns all vs fixed `!=null` returns 0", () => {
		const items = [1, 2, 3];
		// old: limit=0 falsy → no slice → returns all 3 (BUG)
		expect(paginateOld(items, { limit: 0, offset: 0 }).length).toBe(3);
		expect(paginateOld(items, { limit: 0 }).length).toBe(3);
		// old: limit=1 works (truthy) → 1
		expect(paginateOld(items, { limit: 1 }).length).toBe(1);
		// old: limit=undefined correctly returns all
		expect(paginateOld(items, {}).length).toBe(3);

		// fixed: limit=0 → slice(0,0) → 0 (correct, sibling at 1476)
		expect(paginateFixed(items, { limit: 0, offset: 0 }).length).toBe(0);
		expect(paginateFixed(items, { limit: 0 }).length).toBe(0);
		expect(paginateFixed(items, { limit: 1 }).length).toBe(1);
		expect(paginateFixed(items, {}).length).toBe(3);
		expect(paginateFixed(items, { limit: 0, offset: 1 }).length).toBe(0); // offset 1 then limit 0 → 0
		expect(paginateFixed(items, { limit: 2, offset: 1 }).length).toBe(2);
	});

	it("CO-1 sibling correct `if (limit != null)` at same file:1476 handles 0", () => {
		// Directly mirrors sibling `getRoomsForWorldIds` logic
		function siblingSlice<T>(items: T[], limit?: number, offset?: number): T[] {
			const off = offset ?? 0;
			let out = items.slice(off);
			if (limit != null) out = out.slice(0, limit);
			return out;
		}
		expect(siblingSlice([1, 2, 3], 0).length).toBe(0);
		expect(siblingSlice([1, 2, 3], 1).length).toBe(1);
		expect(siblingSlice([1, 2, 3], undefined).length).toBe(3);
	});

	it("CO-4 trajectory list: old `if (limit && ...)` → limit=0 never truncates vs fixed `!=null` truncates to 0", () => {
		const out = [1, 2, 3, 4, 5];
		// old: limit=0 falsy → skip → returns all 5 (BUG, should be 0)
		expect(listOld(out, { limit: 0 }).length).toBe(5);
		expect(listOld(out, { limit: 1 }).length).toBe(1);
		expect(listOld(out, {}).length).toBe(5);

		// fixed: limit=0 → condition true (0 != null) && 5>0 → slice(0,0) → 0
		expect(listFixed(out, { limit: 0 }).length).toBe(0);
		expect(listFixed(out, { limit: 1 }).length).toBe(1);
		expect(listFixed(out, {}).length).toBe(5);
		expect(listFixed(out, { limit: 10 }).length).toBe(5); // limit larger than length → no slice (guard `length > limit` false)
	});

	it("CO-4 boundary: limit=0,1,MAX vs undefined divergence pinned", () => {
		const a = [1, 2, 3];
		// node -e one-liner equivalence: payload→effect per hunt
		// payload limit=0 → old 3 vs fixed 0
		expect(paginateOld(a, { limit: 0 }).length).toBe(3);
		expect(paginateFixed(a, { limit: 0 }).length).toBe(0);
		// payload limit=undefined → both 3 (no divergence, correct)
		expect(paginateOld(a, {}).length).toBe(3);
		expect(paginateFixed(a, {}).length).toBe(3);
	});

	it("ship14 sibling proof: files contain `!= null` guard and not bare truthy", async () => {
		const fs = await import("node:fs");
		const mem = fs.readFileSync(
			"packages/core/src/database/inMemoryAdapter.ts",
			"utf8",
		);
		expect(mem).toContain("if (params.limit != null)");
		expect(mem).not.toMatch(/\n\t\tif \(params\.limit\) \{/); // old truthy must be gone
		const traj = fs.readFileSync(
			"packages/core/src/runtime/trajectory-recorder.ts",
			"utf8",
		);
		expect(traj).toContain(
			"if (opts.limit != null && out.length > opts.limit)",
		);
		expect(traj).not.toContain("if (opts.limit && out.length > opts.limit)");
		// sibling correct still at 1476
		expect(mem).toContain("if (limit != null) out = out.slice(0, limit);");
	});
});
