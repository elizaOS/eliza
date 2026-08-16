/**
 * Pins Ship 19 truthy limit batch (plugin-sql):
 * - plugins/plugin-sql/src/base.ts:6491 `if (offset)` and 6494 `if (limit)` treat 0 as falsy → skips SQL LIMIT/OFFSET 0 → unbounded room dump vs sibling `6211 if (params.limit !== undefined)` and `6214 if (params.offset !== undefined)` and `inMemoryAdapter:1472 if (limit != null)`.
 * Fix: `!= null` guard (1 token, zero regression).
 * Sibling correct: base.ts:6211/6214 !==undefined, inMemoryAdapter:1472 != null, audit-log toBoundedLimit.
 */

import { describe, expect, it } from "vitest";

function oldSqlGetRoomsByWorlds(
	limit: number | undefined,
	offset: number | undefined,
	total: number,
) {
	// replica of old buggy: if (offset) query.offset; if (limit) query.limit
	let out = total;
	if (offset) out = Math.max(0, out - offset); // simplified: offset truthy skips 0
	if (limit) out = Math.min(out, limit);
	return out;
}
function fixedSqlGetRoomsByWorlds(
	limit: number | undefined,
	offset: number | undefined,
	total: number,
) {
	let out = total;
	if (offset != null) out = Math.max(0, out - (offset ?? 0));
	if (limit != null) out = Math.min(out, limit);
	return out;
}

describe("truthy limit sql batch (ship 19) — plugin-sql getRoomsByWorlds", () => {
	it("old limit=0 unbounded vs fixed 0", () => {
		const total = 5000;
		expect(oldSqlGetRoomsByWorlds(0, undefined, total)).toBe(total); // BUG: limit 0 ignored → 5000
		expect(fixedSqlGetRoomsByWorlds(0, undefined, total)).toBe(0); // fixed
		expect(fixedSqlGetRoomsByWorlds(2, undefined, total)).toBe(2);
		expect(fixedSqlGetRoomsByWorlds(undefined, undefined, total)).toBe(total);
	});

	it("old offset=0 skipped vs fixed preserves 0 (no-op but explicit)", () => {
		const total = 100;
		// offset 0 should be explicit 0 (same as no offset). Old skips, fixed applies 0 → same result but proves guard
		expect(oldSqlGetRoomsByWorlds(undefined, 0, total)).toBe(total); // old skips offset 0 → same as total (harmless but inconsistent)
		expect(fixedSqlGetRoomsByWorlds(undefined, 0, total)).toBe(total); // fixed also total, but via explicit path
		// offset 5 vs limit combo
		expect(oldSqlGetRoomsByWorlds(10, 5, 100)).toBe(10);
		expect(fixedSqlGetRoomsByWorlds(10, 5, 100)).toBe(10);
	});

	it("ship19 sibling proof: files use != null / !== undefined not truthy", async () => {
		const fs = await import("node:fs");
		const base = fs.readFileSync("plugins/plugin-sql/src/base.ts", "utf8");
		// check fixed sites
		expect(base).toContain("if (offset != null) {");
		expect(base).toContain("if (limit != null) {");
		// ensure no bare truthy remains for those 2 sites (count)
		const bareOffsetMatches = (base.match(/\n\s+if \(offset\) \{/g) || [])
			.length;
		expect(bareOffsetMatches).toBe(0);
		const bareLimitMatches = (
			base.match(/\n\s+if \(limit\) \{\n\s+query = query\.limit\(limit\)/g) ||
			[]
		).length;
		expect(bareLimitMatches).toBe(0);
		// sibling correct at 6211/6214
		expect(base).toContain(
			"if (params.limit !== undefined && !params.entityIds?.length) {",
		);
		expect(base).toContain(
			"if (params.offset !== undefined && !params.entityIds?.length) {",
		);
		// cross-sibling core inMemoryAdapter
		const mem = fs.readFileSync(
			"packages/core/src/database/inMemoryAdapter.ts",
			"utf8",
		);
		expect(mem).toContain("if (limit != null) out = out.slice(0, limit);");
	});
});
